import { QueueClient, createLogMetrics } from '@megabot/queue';
import type { Logger } from 'pino';
import type { WorkerConfig } from './config';
import { registerHandlers } from './handlers';

export interface RunningWorker {
  /** Para de pegar jobs novos, espera os em andamento e fecha o banco. Seguro chamar várias vezes. */
  stop(): Promise<void>;
  client: QueueClient;
}

export async function startWorker(config: WorkerConfig, logger: Logger): Promise<RunningWorker> {
  const client = new QueueClient({
    connectionString: config.databaseUrl,
    schema: config.queueSchema,
    poolSize: config.poolSize,
    pollingIntervalSeconds: config.pollIntervalSeconds,
    logger,
    metrics: createLogMetrics(logger),
  });

  try {
    await client.start();
    const queues = await registerHandlers(client, config);
    logger.info({ event: 'worker.ready', handlers: queues }, 'Worker pronto');
  } catch (error) {
    await client.stop({ timeoutMs: 1_000 }).catch(() => undefined);
    throw error;
  }

  let stopping: Promise<void> | undefined;
  return {
    client,
    stop() {
      stopping ??= (async () => {
        logger.info({ event: 'worker.stopping' }, 'Desligando: aguardando jobs em andamento');
        await client.stop({ timeoutMs: config.shutdownTimeoutMs });
        logger.info({ event: 'worker.stopped' }, 'Worker encerrado');
      })();
      return stopping;
    },
  };
}
