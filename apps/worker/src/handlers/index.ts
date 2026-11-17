import { QUEUES, type QueueClient } from '@megabot/queue';
import type { WorkerConfig } from '../config';
import { createSystemPingHandler } from './system-ping';

/**
 * Liga cada fila ao seu handler. Filas SEM handler aqui (whatsapp.inbound, whatsapp.outbound,
 * llm.reply) continuam existindo e acumulando jobs; cada task seguinte registra o seu handler
 * AQUI, com uma linha `await client.work(QUEUES.xxx, handler)`.
 */
export async function registerHandlers(
  client: QueueClient,
  config: WorkerConfig,
): Promise<string[]> {
  const registered: string[] = [];

  await client.work(
    QUEUES.systemPing,
    createSystemPingHandler({ allowSimulation: config.env !== 'production' }),
  );
  registered.push(QUEUES.systemPing.name);

  return registered;
}
