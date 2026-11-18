import {
  applyStatusUpdate,
  createLogMetrics,
  getWebhookEvent,
  markWebhookEvent,
  type WebhookEventRecord,
} from '@megabot/database';
import { NonRetryableError, type JobHandler, type QUEUES, type QueueLogger } from '@megabot/queue';
import { z } from 'zod';
import { INBOUND_METRIC } from './inbound-metrics';

/**
 * Job `whatsapp.status` (T1.6): atualiza o status de uma mensagem que NÓS enviamos
 * (`sent` → `delivered` → `read`, ou `failed`), a partir de um evento de status do webhook.
 *
 * Regras (as da T1.4, `applyStatusUpdate`):
 *  - o status só AVANÇA; evento repetido ou fora de ordem é ignorado (a Meta manda `read` antes de
 *    `delivered` às vezes);
 *  - `failed` grava o código e a mensagem de erro da Meta (só enquanto a mensagem não foi entregue);
 *  - wamid desconhecido: o envio talvez ainda não tenha gravado o wamid → o job repete por até
 *    `statusGraceMs` (padrão 10 min); depois disso o evento é descartado (é uma mensagem que
 *    não enviamos, ex.: mandada pelo app do celular da empresa) para não entupir a DLQ.
 *
 * A mesma lógica também roda dentro de `whatsapp.inbound` (T1.5), caso um evento de status chegue
 * por lá: as duas filas usam `processStatusEvent`.
 */

export const DEFAULT_STATUS_GRACE_MS = 10 * 60 * 1000;

export const statusPayload = z.looseObject({
  messageId: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.coerce.date(),
  errors: z
    .array(z.looseObject({ code: z.number().optional(), message: z.string().optional() }))
    .optional(),
});

export type StatusEventOutcome = 'updated' | 'ignored' | 'not_found_ignored' | 'invalid_payload';

export interface ProcessStatusArgs {
  tenantId: string;
  event: WebhookEventRecord;
  now: Date;
  statusGraceMs: number;
  logger: QueueLogger;
}

/**
 * Aplica um evento de status. Devolve o resultado; lança erro REPETÍVEL quando o wamid ainda não
 * existe e o evento é recente. Payload inválido devolve `invalid_payload` (quem chama decide).
 */
export async function processStatusEvent(
  args: ProcessStatusArgs,
): Promise<{ outcome: StatusEventOutcome; fields?: string }> {
  const parsed = statusPayload.safeParse(args.event.payload);
  if (!parsed.success) {
    // Só nomes de campos: nunca valores do payload.
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(raiz)').join(', ');
    return { outcome: 'invalid_payload', fields };
  }
  const st = parsed.data;
  const firstError = st.errors?.[0];
  const metrics = createLogMetrics(args.logger);

  const result = await applyStatusUpdate(
    args.tenantId,
    {
      wamid: st.messageId,
      status: st.status,
      at: st.timestamp,
      ...(firstError?.code !== undefined ? { errorCode: String(firstError.code) } : {}),
      ...(firstError?.message !== undefined ? { errorMessage: firstError.message } : {}),
    },
    { now: args.now, logger: args.logger, metrics },
  );

  if (result === 'not_found') {
    const ageMs = args.now.getTime() - args.event.receivedAt.getTime();
    if (ageMs < args.statusGraceMs) {
      throw new Error('wamid ainda não gravado; tentar de novo');
    }
    return { outcome: 'not_found_ignored' };
  }
  return { outcome: result };
}

export interface MessageStatusDeps {
  now?: () => Date;
  statusGraceMs?: number;
}

export function createMessageStatusHandler(
  deps: MessageStatusDeps = {},
): JobHandler<typeof QUEUES.whatsappStatus> {
  const now = deps.now ?? (() => new Date());
  const statusGraceMs = deps.statusGraceMs ?? DEFAULT_STATUS_GRACE_MS;

  return async ({ payload, logger }) => {
    const { tenantId, webhookEventId } = payload;
    const metrics = createLogMetrics(logger);
    const count = (outcome: string) =>
      metrics.increment(INBOUND_METRIC.events, { tenant_id: tenantId, kind: 'status', outcome });

    const event = await getWebhookEvent(tenantId, webhookEventId);
    if (!event) {
      count('event_not_found');
      throw new NonRetryableError(`Evento ${webhookEventId} não existe neste tenant`);
    }
    if (event.processStatus === 'processed') {
      count('already_processed');
      return;
    }
    if (event.kind !== 'status') {
      count('wrong_kind');
      throw new NonRetryableError(`Evento ${event.id} não é de status (é "${event.kind}")`);
    }

    let result;
    try {
      result = await processStatusEvent({ tenantId, event, now: now(), statusGraceMs, logger });
    } catch (error) {
      count('not_found_retry');
      throw error;
    }
    if (result.outcome === 'invalid_payload') {
      await markWebhookEvent(tenantId, event.id, 'failed', now());
      count('invalid_payload');
      throw new NonRetryableError(`invalid_payload: ${result.fields ?? ''}`);
    }
    await markWebhookEvent(tenantId, event.id, 'processed', now());
    count(result.outcome);
  };
}
