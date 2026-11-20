import { listPendingWebhookEvents, prisma } from '@megabot/database';
import { QUEUES, type QueueClient } from '@megabot/queue';
import type { Logger } from 'pino';

/**
 * Ponte webhook → fila (T1.7). O webhook (T1.2) só GRAVA o evento (`pending`); este relay, dentro do
 * worker, olha de tempos em tempos os eventos pendentes e enfileira `whatsapp.inbound` /
 * `whatsapp.status`. O id do job é o id do evento: repetir não duplica, e se o worker cair nada se
 * perde (o evento continua `pending` no banco até o handler marcá-lo como processado).
 *
 * Por que no worker e não na API: a API continua sem depender do pg-boss (responde rápido à Meta,
 * que exige 200 em poucos segundos) e uma falha da fila não perde evento.
 */
export interface InboxRelay {
  /** Uma varredura; devolve quantos jobs NOVOS foram enfileirados. */
  tick(): Promise<number>;
  stop(): void;
}

export function startInboxRelay(options: {
  client: Pick<QueueClient, 'enqueue'>;
  logger: Pick<Logger, 'info' | 'error'>;
  intervalMs: number;
  /** Só para testes: restringe a varredura a estes tenants (o banco de teste é compartilhado). */
  onlyTenantIds?: readonly string[] | undefined;
}): InboxRelay {
  const { client, logger } = options;
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0; // varreduras não se sobrepõem
    running = true;
    let enqueued = 0;
    try {
      const tenants = await prisma.tenant.findMany({
        select: { id: true },
        ...(options.onlyTenantIds ? { where: { id: { in: [...options.onlyTenantIds] } } } : {}),
      });
      for (const { id: tenantId } of tenants) {
        for (const { id: webhookEventId, kind } of await listPendingWebhookEvents(tenantId)) {
          const queue = kind === 'status' ? QUEUES.whatsappStatus : QUEUES.whatsappInbound;
          const result = await client.enqueue(
            queue,
            { tenantId, webhookEventId },
            { jobId: webhookEventId },
          );
          if (!result.deduplicated) {
            enqueued += 1;
            logger.info(
              {
                event: 'inbox_relay.enqueued',
                tenant_id: tenantId,
                webhook_event_id: webhookEventId,
                queue: queue.name,
              },
              'Evento do webhook enfileirado',
            );
          }
        }
      }
    } catch (error) {
      logger.error({ event: 'inbox_relay.failed', err: error }, 'Falha na varredura do relay');
    } finally {
      running = false;
    }
    return enqueued;
  }

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  void tick();
  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
