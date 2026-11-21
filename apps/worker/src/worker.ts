import { QueueClient, createLogMetrics } from '@megabot/queue';
import type { Logger } from 'pino';
import type { WorkerConfig } from './config';
import { registerHandlers } from './handlers';
import { startInboxRelay, type InboxRelay } from './inbox-relay';
import { startKnowledgeRelay, type KnowledgeRelay } from './knowledge-relay';

export interface RunningWorker {
  /** Para de pegar jobs novos, espera os em andamento e fecha o banco. Seguro chamar várias vezes. */
  stop(): Promise<void>;
  client: QueueClient;
}

export interface StartWorkerOptions {
  /** Só para testes: o relay do webhook varre apenas estes tenants. */
  relayTenantIds?: readonly string[];
}

export async function startWorker(
  config: WorkerConfig,
  logger: Logger,
  options: StartWorkerOptions = {},
): Promise<RunningWorker> {
  const client = new QueueClient({
    connectionString: config.databaseUrl,
    schema: config.queueSchema,
    poolSize: config.poolSize,
    pollingIntervalSeconds: config.pollIntervalSeconds,
    logger,
    metrics: createLogMetrics(logger),
  });

  let relay: InboxRelay | undefined;
  let knowledgeRelay: KnowledgeRelay | undefined;
  try {
    await client.start();
    const queues = await registerHandlers(client, config, logger);
    if (config.inboxRelayIntervalMs > 0) {
      relay = startInboxRelay({
        client,
        logger,
        intervalMs: config.inboxRelayIntervalMs,
        onlyTenantIds: options.relayTenantIds,
      });
      knowledgeRelay = startKnowledgeRelay({
        client,
        logger,
        intervalMs: config.inboxRelayIntervalMs,
        onlyTenantIds: options.relayTenantIds,
      });
    }
    logger.info({ event: 'worker.ready', handlers: queues }, 'Worker pronto');
  } catch (error) {
    relay?.stop();
    knowledgeRelay?.stop();
    await client.stop({ timeoutMs: 1_000 }).catch(() => undefined);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    client,
    stop() {
      stopping ??= (async () => {
        relay?.stop();
        knowledgeRelay?.stop();
        logger.info({ event: 'worker.stopping' }, 'Desligando: aguardando jobs em andamento');
        await client.stop({ timeoutMs: config.shutdownTimeoutMs });
        logger.info({ event: 'worker.stopped' }, 'Worker encerrado');
      })();
      return stopping;
    },
  };
}
