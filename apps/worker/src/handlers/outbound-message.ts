import {
  WindowClosedError,
  createLogMetrics,
  findTenantWhatsappNumber,
  getContactWindow,
  getOutboundMessageForSend,
  markOutboundFailed,
  markOutboundSent,
  prepareOutboundMessage,
  takeWhatsappSendToken,
  type OutboundMessageForSend,
  type OutboundMessageInput,
  type OutboundMessageRecord,
} from '@megabot/database';
import {
  NonRetryableError,
  describeError,
  isRetryable,
  type EnqueueOptions,
  type JobContext,
  type JobHandler,
  type PayloadInputOf,
  type QUEUES,
  type QueueLogger,
} from '@megabot/queue';
import {
  WhatsAppApiError,
  WhatsAppClient,
  type MediaKind,
  type SendMediaInput,
  type SendResult,
  type SendTemplateInput,
  type SendTextInput,
  type WhatsAppClientOptions,
} from '@megabot/whatsapp';
import { z } from 'zod';

/**
 * Job `whatsapp.outbound` (T1.6): envia UMA mensagem pela Cloud API.
 *
 * O job só carrega o id da mensagem (`messages.id`, status `queued`); o conteúdo vem do banco.
 * Passos: ler a mensagem → (se já saiu, parar) → conferir a janela de 24h NA HORA do envio →
 * achar o número do tenant → pegar uma ficha do rate limit → enviar → gravar o wamid.
 *
 * Falhas:
 *  - definitivas (janela fechada, destinatário inválido, token inválido, pedido malformado...):
 *    mensagem `failed` com o código do erro e o job vai direto para a DLQ;
 *  - transitórias (rede, Meta fora do ar, limite de vazão...): a mensagem continua `queued` e o job
 *    é repetido com espera crescente; se as tentativas acabarem, a mensagem vira `failed`.
 *
 * Garantia: "pelo menos uma vez". A Meta não tem chave de idempotência; se o processo cair DEPOIS
 * de a Meta aceitar e ANTES de gravarmos o wamid, o retry reenvia (mensagem duplicada, rara).
 * Um timeout de rede tem o mesmo risco, por isso é contado nas métricas (`timed_out`).
 */

export const OUTBOUND_METRIC = {
  /** Resultado de cada execução. Rótulos: tenant_id, outcome. */
  attempts: 'outbound_messages_total',
  /** Quantas vezes um job esperou/foi devolvido por causa do rate limit. Rótulos: tenant_id, result. */
  rateLimited: 'outbound_rate_limited_total',
} as const;

/** Erro repetível: sem vaga no rate limit dentro do tempo máximo de espera. */
export class RateLimitedError extends Error {
  readonly retryable = true;
  readonly category = 'rate_limit';
  constructor(public readonly retryAfterMs: number) {
    super(`Limite de envio do número atingido; nova vaga em ~${retryAfterMs} ms.`);
    this.name = 'RateLimitedError';
  }
}

/** Parte do cliente da Meta que o job usa (permite trocar por um falso nos testes). */
export type OutboundClient = Pick<WhatsAppClient, 'sendText' | 'sendTemplate' | 'sendMedia'>;

export interface OutboundMessageDeps {
  /** Token da Cloud API (nunca é logado). */
  accessToken: string;
  baseUrl?: string | undefined;
  /** Mensagens por segundo por número. */
  ratePerSecond: number;
  /** Quanto esperar por uma vaga antes de devolver o job à fila (ms). */
  rateLimitMaxWaitMs: number;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  createClient?: (options: WhatsAppClientOptions) => OutboundClient;
  fetch?: typeof fetch;
}

const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'audio', 'document', 'sticker'];

const templateContent = z.object({
  name: z.string().min(1),
  language: z.string().min(1),
  components: z.array(z.looseObject({ type: z.string() })).optional(),
});

const mediaContent = z
  .object({
    id: z.string().min(1).optional(),
    link: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
  })
  .refine((c) => (c.id === undefined) !== (c.link === undefined), {
    message: 'informe `id` OU `link` da mídia',
  });

export const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export function createOutboundMessageHandler(
  deps: OutboundMessageDeps,
): JobHandler<typeof QUEUES.whatsappOutbound> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const createClient = deps.createClient ?? ((o: WhatsAppClientOptions) => new WhatsAppClient(o));

  return async (ctx) => {
    const { tenantId, outboundMessageId } = ctx.payload;
    const { logger } = ctx;
    const metrics = createLogMetrics(logger);
    const count = (outcome: string) =>
      metrics.increment(OUTBOUND_METRIC.attempts, { tenant_id: tenantId, outcome });

    const message = await getOutboundMessageForSend(tenantId, outboundMessageId);
    if (!message) {
      count('message_not_found');
      throw new NonRetryableError(`Mensagem ${outboundMessageId} não existe neste tenant`);
    }

    // Já enviada (retry depois de gravar o wamid, ou job duplicado): nada a fazer.
    if (message.status !== 'queued' || message.wamid !== null) {
      count('already_sent');
      logger.info(
        {
          event: 'outbound.skipped',
          tenant_id: tenantId,
          message_id: message.id,
          status: message.status,
          reason: 'already_sent',
        },
        'Mensagem já enviada: ignorada',
      );
      return;
    }

    // Falha DEFINITIVA: marca `failed` e manda o job para a DLQ.
    const failPermanently = async (
      code: string,
      error: Error & { retryable?: boolean },
    ): Promise<never> => {
      await markOutboundFailed(tenantId, message.id, {
        errorCode: code,
        errorMessage: describeError(error).message,
      });
      count(`failed_${code}`);
      throw error;
    };

    // 1) Janela de 24h, conferida AGORA (ADR 0010, decisão 6). Template é sempre permitido.
    if (message.type !== 'template') {
      const window = await getContactWindow(tenantId, message.contactId, { now: now() });
      if (!window.canSendFreeform) {
        metrics.increment('conversation_outbound_blocked_total', {
          tenant_id: tenantId,
          reason: 'window_closed_at_send',
        });
        logger.warn(
          {
            event: 'outbound.blocked',
            tenant_id: tenantId,
            message_id: message.id,
            reason: 'window_closed',
          },
          'Envio livre bloqueado: janela de 24h fechada',
        );
        return failPermanently('window_expired', new WindowClosedError(message.contactId));
      }
    }

    // 2) Número do tenant.
    const number = await findTenantWhatsappNumber(tenantId);
    if (!number) {
      return failPermanently(
        'no_whatsapp_number',
        new NonRetryableError('O tenant não tem número do WhatsApp conectado.'),
      );
    }

    // 3) Montar a chamada (valida o conteúdo antes de gastar ficha).
    let send: (client: OutboundClient) => Promise<SendResult>;
    try {
      send = buildSend(message);
    } catch (error) {
      return failPermanently(
        'invalid_message',
        new NonRetryableError(`Mensagem inválida: ${(error as Error).message}`),
      );
    }

    try {
      // 4) Rate limit por número.
      await waitForRateLimitSlot({
        tenantId,
        phoneNumberId: number.phoneNumberId,
        ratePerSecond: deps.ratePerSecond,
        maxWaitMs: deps.rateLimitMaxWaitMs,
        now,
        sleep,
        signal: ctx.signal,
        logger,
      });

      // 5) Enviar.
      const client = createClient({
        accessToken: deps.accessToken,
        phoneNumberId: number.phoneNumberId,
        tenantId,
        ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        logger: logger as WhatsAppClientOptions['logger'] & object,
        metrics: {
          increment: metrics.increment,
          timing: (name: string, ms: number, labels?: Record<string, string>) =>
            logger.info(
              { event: 'metric', metric: name, metric_type: 'timing_ms', value: ms, ...labels },
              'metric',
            ),
        },
      });
      const result = await send(client);

      // 6) Guardar o wamid (a partir daqui os webhooks de status acham a mensagem).
      await markOutboundSent(tenantId, message.id, { wamid: result.messageId }, { now: now() });
      count('sent');
      logger.info(
        {
          event: 'outbound.sent',
          tenant_id: tenantId,
          message_id: message.id,
          type: message.type,
          attempt: ctx.attempt,
        },
        'Mensagem enviada',
      );
    } catch (error) {
      await handleSendError(error, ctx, message, failPermanently, count);
    }
  };
}

/** Decide o destino de uma falha de envio: definitiva, repetir ou desistir na última tentativa. */
async function handleSendError(
  error: unknown,
  ctx: JobContext<typeof QUEUES.whatsappOutbound>,
  message: OutboundMessageForSend,
  failPermanently: (code: string, error: Error & { retryable?: boolean }) => Promise<never>,
  count: (outcome: string) => void,
): Promise<never> {
  const { tenantId } = ctx;
  const summary = describeError(error);
  const code = errorCodeOf(error);
  const err = error instanceof Error ? error : new Error(String(error));

  if (!isRetryable(error)) {
    ctx.logger.error(
      {
        event: 'outbound.failed',
        tenant_id: tenantId,
        message_id: message.id,
        code,
        retryable: false,
        error: summary,
      },
      'Envio falhou (definitivo)',
    );
    return failPermanently(code, err);
  }

  const lastAttempt = ctx.attempt >= ctx.maxAttempts;
  if (lastAttempt) {
    ctx.logger.error(
      {
        event: 'outbound.failed',
        tenant_id: tenantId,
        message_id: message.id,
        code,
        retryable: true,
        last_attempt: true,
        error: summary,
      },
      'Envio falhou: tentativas esgotadas',
    );
    return failPermanently(code, err);
  }

  count(`retry_${code}`);
  ctx.logger.warn(
    {
      event: 'outbound.retry',
      tenant_id: tenantId,
      message_id: message.id,
      code,
      attempt: ctx.attempt,
      max_attempts: ctx.maxAttempts,
      error: summary,
    },
    'Envio falhou: será repetido',
  );
  throw err;
}

/** Código curto e estável do erro, para `messages.error_code` e métricas. */
function errorCodeOf(error: unknown): string {
  if (error instanceof WhatsAppApiError) return String(error.code ?? error.category);
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: unknown; category?: unknown };
    if (typeof e.code === 'string') return e.code;
    if (typeof e.category === 'string') return e.category;
  }
  return 'unknown';
}

function buildSend(
  message: OutboundMessageForSend,
): (client: OutboundClient) => Promise<SendResult> {
  const to = message.waId;
  switch (message.type) {
    case 'text': {
      if (!message.body) throw new Error('texto sem corpo');
      const input: SendTextInput = { to, body: message.body };
      return (c) => c.sendText(input);
    }
    case 'template': {
      const content = templateContent.parse(message.content);
      const input: SendTemplateInput = {
        to,
        name: content.name,
        language: content.language,
        ...(content.components ? { components: content.components as never } : {}),
      };
      return (c) => c.sendTemplate(input);
    }
    default: {
      const kind = MEDIA_KINDS.find((k) => k === message.type);
      if (!kind) throw new Error(`tipo "${message.type}" não é enviável`);
      const content = mediaContent.parse(message.content);
      const media =
        content.id !== undefined ? { id: content.id } : { link: content.link as string };
      const input: SendMediaInput = {
        to,
        kind,
        media,
        ...(message.body ? { caption: message.body } : {}),
        ...(content.filename ? { filename: content.filename } : {}),
      };
      return (c) => c.sendMedia(input);
    }
  }
}

interface RateLimitArgs {
  tenantId: string;
  phoneNumberId: string;
  ratePerSecond: number;
  maxWaitMs: number;
  now: () => Date;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  logger: QueueLogger;
}

/**
 * Pega uma ficha do balde do número. Sem ficha, espera (até `maxWaitMs` no total) e tenta de novo;
 * se ainda assim não houver vaga, lança `RateLimitedError` (repetível, o job volta à fila).
 */
export async function waitForRateLimitSlot(args: RateLimitArgs): Promise<void> {
  const metrics = createLogMetrics(args.logger);
  let waitedMs = 0;
  for (;;) {
    const taken = await takeWhatsappSendToken(args.tenantId, args.phoneNumberId, {
      ratePerSecond: args.ratePerSecond,
      now: args.now(),
    });
    if (taken.allowed) {
      if (waitedMs > 0) {
        metrics.increment(OUTBOUND_METRIC.rateLimited, {
          tenant_id: args.tenantId,
          result: 'waited',
        });
      }
      return;
    }
    if (waitedMs + taken.retryAfterMs > args.maxWaitMs || args.signal.aborted) {
      metrics.increment(OUTBOUND_METRIC.rateLimited, {
        tenant_id: args.tenantId,
        result: 'deferred',
      });
      throw new RateLimitedError(taken.retryAfterMs);
    }
    await args.sleep(taken.retryAfterMs, args.signal);
    waitedMs += taken.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Produtor: quem quer ENVIAR uma mensagem usa esta função (agente, atendente humano...)
// ---------------------------------------------------------------------------

export interface QueueOutboundDeps {
  enqueue: (
    payload: PayloadInputOf<typeof QUEUES.whatsappOutbound>,
    options: EnqueueOptions,
  ) => Promise<unknown>;
  now?: () => Date;
}

/**
 * Cria a mensagem (`queued`) e enfileira o envio. A janela é conferida JÁ AQUI (resposta rápida a
 * quem pede: `WindowClosedError` na hora) e de novo no momento do envio (a janela pode fechar na fila).
 * O id do job é o id da mensagem: enfileirar duas vezes não duplica.
 */
export async function queueOutboundMessage(
  deps: QueueOutboundDeps,
  tenantId: string,
  input: OutboundMessageInput,
): Promise<OutboundMessageRecord> {
  const record = await prepareOutboundMessage(tenantId, input, deps.now ? { now: deps.now() } : {});
  await deps.enqueue({ tenantId, outboundMessageId: record.id }, { jobId: record.id });
  return record;
}
