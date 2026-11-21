import {
  listKnowledgeSourcesWithStaleChunks,
  listPendingKnowledgeSources,
  prisma,
} from '@megabot/database';
import { QUEUES, jobIdFor, type QueueClient } from '@megabot/queue';
import type { Logger } from 'pino';

/**
 * Ponte base de conhecimento -> fila (T2.2), no mesmo espírito do relay do webhook (T1.7):
 * a API só GRAVA a fonte com status `pending`; é este relay, dentro do worker, que enfileira
 * `knowledge.ingest`. Assim a API não depende do pg-boss e nada se perde se a fila estiver fora.
 *
 * Também cuida do caminho curto: fontes com trechos editados à mão (`embedding_stale`) ganham um
 * job no modo `stale`, que só recalcula o embedding desses trechos.
 *
 * Idempotência: o `jobId` é derivado da fonte + do instante da última mudança (`updatedAt`), via
 * `jobIdFor` (o pg-boss exige UUID). Enfileirar de novo o mesmo pedido não cria um segundo job;
 * um pedido NOVO (reingestão, nova edição) cria.
 */
export interface KnowledgeRelay {
  /**
   * Uma varredura; devolve quantos jobs NOVOS foram enfileirados. Se já houver uma varredura em
   * andamento (o relay varre sozinho), devolve o resultado dela em vez de rodar duas ao mesmo tempo.
   */
  tick(): Promise<number>;
  stop(): void;
}

export function startKnowledgeRelay(options: {
  client: Pick<QueueClient, 'enqueue'>;
  logger: Pick<Logger, 'info' | 'error'>;
  intervalMs: number;
  /** Só para testes: restringe a varredura a estes tenants (o banco de teste é compartilhado). */
  onlyTenantIds?: readonly string[] | undefined;
}): KnowledgeRelay {
  const { client, logger } = options;
  let running: Promise<number> | null = null;

  async function scan(): Promise<number> {
    let enqueued = 0;
    try {
      const tenants = await prisma.tenant.findMany({
        select: { id: true },
        ...(options.onlyTenantIds ? { where: { id: { in: [...options.onlyTenantIds] } } } : {}),
      });

      for (const { id: tenantId } of tenants) {
        for (const source of await listPendingKnowledgeSources(tenantId)) {
          const result = await client.enqueue(
            QUEUES.knowledgeIngest,
            { tenantId, sourceId: source.id, mode: 'full' },
            { jobId: jobIdFor('knowledge-full', source.id, source.updatedAt.getTime()) },
          );
          if (!result.deduplicated) {
            enqueued += 1;
            logger.info(
              {
                event: 'knowledge_relay.enqueued',
                tenant_id: tenantId,
                source_id: source.id,
                mode: 'full',
              },
              'Fonte enfileirada para ingestão',
            );
          }
        }

        for (const stale of await listKnowledgeSourcesWithStaleChunks(tenantId)) {
          const result = await client.enqueue(
            QUEUES.knowledgeIngest,
            { tenantId, sourceId: stale.sourceId, mode: 'stale' },
            { jobId: jobIdFor('knowledge-stale', stale.sourceId, stale.lastStaleAt.getTime()) },
          );
          if (!result.deduplicated) {
            enqueued += 1;
            logger.info(
              {
                event: 'knowledge_relay.enqueued',
                tenant_id: tenantId,
                source_id: stale.sourceId,
                mode: 'stale',
                chunk_count: stale.staleCount,
              },
              'Trechos editados enfileirados para reembedding',
            );
          }
        }
      }
    } catch (error) {
      logger.error(
        { event: 'knowledge_relay.failed', err: error },
        'Falha na varredura da base de conhecimento',
      );
    }
    return enqueued;
  }

  function tick(): Promise<number> {
    running ??= scan().finally(() => {
      running = null;
    });
    return running;
  }

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  void tick();
  return { tick, stop: () => clearInterval(timer) };
}
