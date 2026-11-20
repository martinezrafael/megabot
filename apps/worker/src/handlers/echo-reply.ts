import {
  WindowClosedError,
  createLogMetrics,
  getWebhookEvent,
  withTenant,
  type OutboundMessageRecord,
} from '@megabot/database';
import { NonRetryableError, QUEUES, type JobHandler } from '@megabot/queue';
import { queueOutboundMessage, type QueueOutboundDeps } from './outbound-message';

export const ECHO_METRIC = { replies: 'echo_replies_total' } as const;

export interface EchoReplyDeps {
  enqueueOutbound: QueueOutboundDeps['enqueue'];
  now?: () => Date;
}

/**
 * Handler de `llm.reply` que ECOA o texto recebido ("Eco: <texto>"). É o "agente" mais simples
 * possível e existe só para validar o fluxo inteiro da T1.7 (webhook → fila → decisão → envio).
 * Só é registrado com `WORKER_ECHO_ENABLED=true` (e nunca em produção). Quando o agente real
 * (LLM) chegar, ele assume `llm.reply` no lugar deste.
 *
 * O texto do cliente vai só para a mensagem de resposta; NUNCA para logs.
 */
export function createEchoReplyHandler(deps: EchoReplyDeps): JobHandler<typeof QUEUES.llmReply> {
  return async ({ payload, logger }) => {
    const { tenantId, conversationId, inboundEventId } = payload;
    const metrics = createLogMetrics(logger);
    const count = (outcome: string) =>
      metrics.increment(ECHO_METRIC.replies, { tenant_id: tenantId, outcome });

    const event = await getWebhookEvent(tenantId, inboundEventId);
    const text =
      event && typeof (event.payload as { text?: unknown } | null)?.text === 'string'
        ? ((event.payload as { text: string }).text as string)
        : null;
    if (!text) {
      count('skipped_no_text');
      logger.info(
        { event: 'echo.skipped', tenant_id: tenantId, conversation_id: conversationId },
        'Eco ignorado: a mensagem não tem texto',
      );
      return;
    }

    const conversation = await withTenant(tenantId, (tx) =>
      tx.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true } }),
    );
    if (!conversation) {
      count('conversation_not_found');
      throw new NonRetryableError(`Conversa ${conversationId} não existe neste tenant`);
    }

    let record: OutboundMessageRecord;
    try {
      record = await queueOutboundMessage(
        { enqueue: deps.enqueueOutbound, ...(deps.now ? { now: deps.now } : {}) },
        tenantId,
        { contactId: conversation.contactId, sender: 'bot', type: 'text', body: `Eco: ${text}` },
      );
    } catch (error) {
      if (error instanceof WindowClosedError) {
        count('window_closed');
        logger.warn(
          { event: 'echo.blocked', tenant_id: tenantId, conversation_id: conversationId },
          'Eco bloqueado: janela de 24h fechada',
        );
        return;
      }
      throw error;
    }
    count('queued');
    logger.info(
      {
        event: 'echo.queued',
        tenant_id: tenantId,
        conversation_id: conversationId,
        message_id: record.id,
      },
      'Eco enfileirado para envio',
    );
  };
}
