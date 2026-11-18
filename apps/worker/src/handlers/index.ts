import { QUEUES, type QueueClient } from '@megabot/queue';
import type { WorkerConfig } from '../config';
import { createInboundMessageHandler } from './inbound-message';
import { createSystemPingHandler } from './system-ping';

/**
 * Liga cada fila ao seu handler. Filas SEM handler aqui (whatsapp.outbound,
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

  // T1.5: processa os eventos do webhook (mensagem, status) e decide se aciona o agente.
  await client.work(
    QUEUES.whatsappInbound,
    createInboundMessageHandler({
      enqueueReply: async (payload, options) => {
        await client.enqueue(QUEUES.llmReply, payload, options);
      },
    }),
  );
  registered.push(QUEUES.whatsappInbound.name);

  return registered;
}
