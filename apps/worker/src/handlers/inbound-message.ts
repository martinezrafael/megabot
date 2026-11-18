import { createHash } from 'node:crypto';
import {
  applyStatusUpdate,
  createLogMetrics,
  decideAgentTrigger,
  getConversationQuotaPosition,
  getTenantGate,
  getWebhookEvent,
  markWebhookEvent,
  recordInboundMessage,
  type InboundMessageResult,
  type Prisma,
  type WebhookEventRecord,
} from '@megabot/database';
import { NonRetryableError, type JobHandler, type PayloadOf, type QUEUES } from '@megabot/queue';
import { z } from 'zod';

/**
 * Job `whatsapp.inbound` (T1.5): processa UM evento já gravado em `webhook_events`.
 *
 *   mensagem → cria/atualiza contato e conversa → grava a mensagem (idempotente)
 *            → decide se aciona o agente → enfileira `llm.reply`
 *   status   → atualiza o status da mensagem enviada (sent/delivered/read/failed)
 *   erro     → só registra no log
 *
 * Reprocessar o MESMO evento (retry do job, reentrega, queda no meio) é seguro:
 *  - a mensagem tem `wamid` único (não duplica nem renova a janela de novo);
 *  - o `llm.reply` é enfileirado com um id calculado a partir do evento (não duplica);
 *  - o evento só é marcado `processed` no FIM; um evento `processed` é ignorado.
 */

export const INBOUND_METRIC = {
  /** Eventos processados. Rótulos: tenant_id, kind, outcome. */
  events: 'inbound_events_total',
  /** Decisão de acionar o agente. Rótulos: tenant_id, trigger (true|false), reason. */
  decisions: 'inbound_agent_decisions_total',
} as const;

export interface InboundMessageDeps {
  /** Enfileira `llm.reply`. `jobId` é fixo por evento: enfileirar duas vezes cria um job só. */
  enqueueReply: (
    payload: PayloadOf<typeof QUEUES.llmReply>,
    options: { jobId: string },
  ) => Promise<void>;
  now?: () => Date;
  /**
   * Quanto tempo esperar o wamid de uma mensagem ENVIADA aparecer no banco antes de desistir
   * de um status "órfão" (ex.: mensagem enviada pelo app do celular da empresa). Padrão: 10 min.
   */
  statusGraceMs?: number;
}

const DEFAULT_STATUS_GRACE_MS = 10 * 60 * 1000;

/** Só o que precisamos do payload gravado pelo webhook (T1.2); o resto é preservado em `content`. */
const messagePayload = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  from: z.string().regex(/^[0-9]{7,15}$/, 'wa_id inválido'),
  profileName: z.string().optional(),
  timestamp: z.coerce.date(),
  text: z.string().optional(),
  media: z.looseObject({ caption: z.string().optional() }).optional(),
  button: z.looseObject({ text: z.string().optional() }).optional(),
  interactive: z.looseObject({ title: z.string().optional() }).optional(),
});

const statusPayload = z.looseObject({
  messageId: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.coerce.date(),
  errors: z
    .array(z.looseObject({ code: z.number().optional(), message: z.string().optional() }))
    .optional(),
});

/** Campos do payload que viram `messages.content` (tudo menos o texto, que vai em `body`). */
const CONTENT_KEYS = [
  'rawType',
  'media',
  'location',
  'contacts',
  'button',
  'interactive',
  'reaction',
  'context',
  'referral',
  'errors',
] as const;

export function pickBody(p: z.infer<typeof messagePayload>): string | null {
  return p.text ?? p.button?.text ?? p.interactive?.title ?? p.media?.caption ?? null;
}

export function pickContent(p: z.infer<typeof messagePayload>): Record<string, unknown> | null {
  const content: Record<string, unknown> = {};
  for (const key of CONTENT_KEYS) {
    if (p[key] !== undefined) content[key] = p[key];
  }
  return Object.keys(content).length > 0 ? content : null;
}

/** UUID estável calculado a partir de um texto (mesma entrada → mesmo id). */
export function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // versão 5
  h[8] = (h[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createInboundMessageHandler(
  deps: InboundMessageDeps,
): JobHandler<typeof QUEUES.whatsappInbound> {
  const now = deps.now ?? (() => new Date());
  const statusGraceMs = deps.statusGraceMs ?? DEFAULT_STATUS_GRACE_MS;

  return async ({ payload, logger }) => {
    const { tenantId, webhookEventId } = payload;
    const metrics = createLogMetrics(logger);
    const count = (kind: string, outcome: string) =>
      metrics.increment(INBOUND_METRIC.events, { tenant_id: tenantId, kind, outcome });

    const event = await getWebhookEvent(tenantId, webhookEventId);
    if (!event) {
      count('unknown', 'event_not_found');
      throw new NonRetryableError(`Evento ${webhookEventId} não existe neste tenant`);
    }
    if (event.processStatus === 'processed') {
      count(event.kind, 'already_processed');
      logger.info(
        {
          event: 'inbound.skipped',
          tenant_id: tenantId,
          webhook_event_id: event.id,
          reason: 'already_processed',
        },
        'Evento já processado: ignorado',
      );
      return;
    }

    const fail = async (reason: string, detail: string): Promise<never> => {
      await markWebhookEvent(tenantId, event.id, 'failed', now());
      count(event.kind, reason);
      throw new NonRetryableError(`${reason}: ${detail}`);
    };

    switch (event.kind) {
      case 'message':
        await processMessage(event, fail);
        break;
      case 'status':
        await processStatus(event, fail);
        break;
      case 'error':
        logger.warn(
          { event: 'inbound.system_error', tenant_id: tenantId, webhook_event_id: event.id },
          'Erro de sistema informado pela Meta (veja o payload do evento)',
        );
        count('error', 'logged');
        break;
      default:
        await fail('unknown_kind', String(event.kind));
    }

    await markWebhookEvent(tenantId, event.id, 'processed', now());

    // ------------------------------------------------------------------ mensagem
    async function processMessage(
      ev: WebhookEventRecord,
      failFn: (reason: string, detail: string) => Promise<never>,
    ): Promise<void> {
      const parsed = messagePayload.safeParse(ev.payload);
      if (!parsed.success) {
        // Nada de texto do payload no erro: só os campos que falharam.
        const fields = parsed.error.issues.map((i) => i.path.join('.') || '(raiz)').join(', ');
        return failFn('invalid_payload', fields);
      }
      const msg = parsed.data;
      const content = pickContent(msg);

      const recorded: InboundMessageResult = await recordInboundMessage(
        tenantId,
        {
          waId: msg.from,
          profileName: msg.profileName ?? null,
          wamid: msg.id,
          type: msg.type,
          body: pickBody(msg),
          content: content as Prisma.InputJsonObject | null,
          sentAt: msg.timestamp,
        },
        { now: now(), logger, metrics },
      );

      // Decisão: tenant, janela, tipo e cota (função pura + dois fatos lidos do banco).
      const gate = await getTenantGate(tenantId);
      const position = await getConversationQuotaPosition(tenantId, recorded.conversationId);
      const decision = decideAgentTrigger({
        tenantStatus: gate?.status ?? 'missing',
        messageType: msg.type,
        windowOpen: recorded.windowExpiresAt.getTime() > now().getTime(),
        quotaLimit: gate?.conversationLimitPerMonth ?? null,
        quotaPosition: position ?? Number.MAX_SAFE_INTEGER,
      });

      metrics.increment(INBOUND_METRIC.decisions, {
        tenant_id: tenantId,
        trigger: String(decision.trigger),
        reason: decision.reason,
      });
      logger.info(
        {
          event: 'inbound.decision',
          tenant_id: tenantId,
          webhook_event_id: ev.id,
          conversation_id: recorded.conversationId,
          message_id: recorded.messageId,
          window: recorded.window,
          duplicate: recorded.duplicate,
          trigger: decision.trigger,
          reason: decision.reason,
          quota_position: position,
          quota_limit: gate?.conversationLimitPerMonth ?? null,
        },
        decision.trigger ? 'Agente acionado' : 'Agente NÃO acionado',
      );

      if (decision.trigger) {
        await deps.enqueueReply(
          { tenantId, conversationId: recorded.conversationId, inboundEventId: ev.id },
          { jobId: deterministicUuid(`llm.reply:${ev.id}`) },
        );
      }
      count('message', decision.trigger ? 'agent_triggered' : `skipped_${decision.reason}`);
    }

    // -------------------------------------------------------------------- status
    async function processStatus(
      ev: WebhookEventRecord,
      failFn: (reason: string, detail: string) => Promise<never>,
    ): Promise<void> {
      const parsed = statusPayload.safeParse(ev.payload);
      if (!parsed.success) {
        const fields = parsed.error.issues.map((i) => i.path.join('.') || '(raiz)').join(', ');
        return failFn('invalid_payload', fields);
      }
      const st = parsed.data;
      const firstError = st.errors?.[0];
      const outcome = await applyStatusUpdate(
        tenantId,
        {
          wamid: st.messageId,
          status: st.status,
          at: st.timestamp,
          ...(firstError?.code !== undefined ? { errorCode: String(firstError.code) } : {}),
          ...(firstError?.message !== undefined ? { errorMessage: firstError.message } : {}),
        },
        { now: now(), logger, metrics },
      );

      if (outcome === 'not_found') {
        const ageMs = now().getTime() - ev.receivedAt.getTime();
        if (ageMs < statusGraceMs) {
          // O envio talvez ainda não tenha gravado o wamid: tenta de novo (retry da fila).
          count('status', 'not_found_retry');
          throw new Error('wamid ainda não gravado; tentar de novo');
        }
        count('status', 'not_found_ignored');
        return;
      }
      count('status', outcome);
    }
  };
}
