import { z } from 'zod';

/**
 * Definição das filas do MegaBot.
 *
 * Regras que valem para TODAS:
 *  - o payload carrega só IDs (nunca texto de mensagem nem dados pessoais): o conteúdo mora no banco,
 *    protegido por RLS, e o job só diz "qual linha processar";
 *  - o payload SEMPRE tem `tenantId` (vai em todo log e métrica);
 *  - entrega "pelo menos uma vez" (ADR 0005): o handler precisa ser idempotente. Para o enfileiramento
 *    também ser, passe `jobId` em `enqueue` (ex.: o id do webhook_event).
 *
 * Retentativas: espera exponencial com sorteio (jitter) a partir de `retryDelaySeconds`, limitada a
 * `retryDelayMaxSeconds`. Esgotadas as tentativas, o job é copiado para a fila `<nome>.dlq`.
 */

const tenantId = z.uuid({ error: 'tenantId precisa ser um UUID' });

export interface QueueRetryPolicy {
  /** Quantas vezes repetir DEPOIS da primeira tentativa (total de execuções = limit + 1). */
  retryLimit: number;
  /** Espera inicial, em segundos. */
  retryDelaySeconds: number;
  /** Teto da espera entre tentativas, em segundos. */
  retryDelayMaxSeconds: number;
}

export interface QueueDefinition<S extends z.ZodType = z.ZodType> {
  /** Nome da fila no pg-boss (letras, números, ponto, hífen e sublinhado). */
  readonly name: string;
  /** Fila de falhas: recebe o job quando as tentativas acabam (ou o erro é definitivo). */
  readonly deadLetterName: string;
  readonly description: string;
  readonly payload: S;
  readonly retry: QueueRetryPolicy;
  /** Tempo máximo de uma execução; passou disso o job conta como falha e é repetido. */
  readonly expireInSeconds: number;
  /** Quantos jobs desta fila este processo executa ao mesmo tempo. */
  readonly concurrency: number;
  /** Quanto tempo manter o job concluído (para consulta no admin), em segundos. */
  readonly keepCompletedSeconds: number;
}

type DefinitionInput<S extends z.ZodType> = Omit<QueueDefinition<S>, 'deadLetterName'>;

export function defineQueue<S extends z.ZodType>(input: DefinitionInput<S>): QueueDefinition<S> {
  if (!/^[\w.-]+$/.test(input.name)) {
    throw new Error(`Nome de fila inválido: "${input.name}"`);
  }
  return { ...input, deadLetterName: `${input.name}.dlq` };
}

const DAY = 24 * 60 * 60;

/** Tempo que um job falho fica na DLQ para alguém investigar (30 dias). */
export const DLQ_RETENTION_SECONDS = 30 * DAY;

export const QUEUES = {
  /** Teste de fumaça do pipeline de filas (também usado pelo script `queue:smoke`). */
  systemPing: defineQueue({
    name: 'system.ping',
    description: 'Teste de fumaça: confirma que enfileirar, executar e falhar funcionam.',
    payload: z.object({
      tenantId,
      /** Só tem efeito fora de produção (ver apps/worker): força sucesso ou falha. */
      simulate: z.enum(['ok', 'retryable-failure', 'fatal-failure']).default('ok'),
    }),
    retry: { retryLimit: 2, retryDelaySeconds: 2, retryDelayMaxSeconds: 30 },
    expireInSeconds: 60,
    concurrency: 1,
    keepCompletedSeconds: DAY,
  }),

  /** Processa um evento recebido do webhook (mensagem ou status) já gravado em webhook_events. */
  whatsappInbound: defineQueue({
    name: 'whatsapp.inbound',
    description: 'Processar evento recebido do WhatsApp (linha de webhook_events).',
    payload: z.object({ tenantId, webhookEventId: z.uuid() }),
    retry: { retryLimit: 6, retryDelaySeconds: 5, retryDelayMaxSeconds: 10 * 60 },
    expireInSeconds: 2 * 60,
    concurrency: 5,
    keepCompletedSeconds: 3 * DAY,
  }),

  /** Atualiza o status (sent, delivered, read, failed) de uma mensagem ENVIADA, vindo do webhook. */
  whatsappStatus: defineQueue({
    name: 'whatsapp.status',
    description: 'Atualizar o status de entrega de uma mensagem enviada (evento de status).',
    payload: z.object({ tenantId, webhookEventId: z.uuid() }),
    retry: { retryLimit: 6, retryDelaySeconds: 5, retryDelayMaxSeconds: 10 * 60 },
    expireInSeconds: 60,
    concurrency: 5,
    keepCompletedSeconds: 3 * DAY,
  }),

  /** Envia uma mensagem pela Cloud API (o conteúdo fica no banco; o job só aponta para ele). */
  whatsappOutbound: defineQueue({
    name: 'whatsapp.outbound',
    description: 'Enviar mensagem pela WhatsApp Cloud API.',
    payload: z.object({ tenantId, outboundMessageId: z.uuid() }),
    retry: { retryLimit: 8, retryDelaySeconds: 5, retryDelayMaxSeconds: 15 * 60 },
    expireInSeconds: 60,
    concurrency: 5,
    keepCompletedSeconds: 3 * DAY,
  }),

  /** Gera a resposta do assistente (chamada ao LLM: lenta e sujeita a limite de uso). */
  llmReply: defineQueue({
    name: 'llm.reply',
    description: 'Gerar resposta do assistente com o LLM.',
    payload: z.object({ tenantId, conversationId: z.uuid(), inboundEventId: z.uuid() }),
    retry: { retryLimit: 4, retryDelaySeconds: 10, retryDelayMaxSeconds: 5 * 60 },
    expireInSeconds: 3 * 60,
    concurrency: 3,
    keepCompletedSeconds: 3 * DAY,
  }),
} as const;

export const ALL_QUEUES: readonly QueueDefinition[] = Object.values(QUEUES);

/** Payload (já validado) de uma fila. */
export type PayloadOf<D extends QueueDefinition> = z.output<D['payload']>;
/** Payload aceito por `enqueue` (campos com padrão podem faltar). */
export type PayloadInputOf<D extends QueueDefinition> = z.input<D['payload']>;

/** Acha a definição pelo nome da fila ou da DLQ. */
export function findQueueByName(name: string): QueueDefinition | undefined {
  return ALL_QUEUES.find((q) => q.name === name || q.deadLetterName === name);
}
