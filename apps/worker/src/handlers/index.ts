import { createOpenAiProvider } from '@megabot/ai';
import { getWhatsappAccessToken } from '@megabot/database';
import { QUEUES, type QueueClient } from '@megabot/queue';
import type { Logger } from 'pino';
import type { WorkerConfig } from '../config';
import { createEchoReplyHandler } from './echo-reply';
import { createInboundMessageHandler } from './inbound-message';
import { createIngestKnowledgeHandler } from './ingest-knowledge';
import { createMessageStatusHandler } from './message-status';
import { createOutboundMessageHandler } from './outbound-message';
import { createSystemPingHandler } from './system-ping';

/**
 * Liga cada fila ao seu handler. Filas SEM handler aqui (llm.reply) continuam existindo e acumulando jobs; cada task seguinte registra o seu handler
 * AQUI, com uma linha `await client.work(QUEUES.xxx, handler)`.
 */
export async function registerHandlers(
  client: QueueClient,
  config: WorkerConfig,
  logger?: Pick<Logger, 'warn' | 'info' | 'error'>,
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

  // T1.6: atualiza o status (sent/delivered/read/failed) das mensagens que enviamos.
  await client.work(QUEUES.whatsappStatus, createMessageStatusHandler());
  registered.push(QUEUES.whatsappStatus.name);

  // T1.6/T1.7: envia mensagens pela Cloud API com o token do PRÓPRIO número (cifrado no banco).
  // Sem chaveiro e sem token global o worker NÃO pega esses jobs: eles esperam na fila (em vez de
  // falhar e ir para a DLQ) até a configuração existir.
  const cipher = config.tokenCipher;
  if (cipher || config.whatsapp.accessToken) {
    await client.work(
      QUEUES.whatsappOutbound,
      createOutboundMessageHandler({
        accessToken: config.whatsapp.accessToken,
        ...(cipher
          ? {
              resolveAccessToken: async (tenantId: string, phoneNumberId: string) =>
                (await getWhatsappAccessToken(tenantId, cipher, phoneNumberId))?.accessToken ??
                null,
            }
          : {}),
        baseUrl: config.whatsapp.baseUrl,
        ratePerSecond: config.whatsapp.ratePerSecond,
        rateLimitMaxWaitMs: config.whatsapp.rateLimitMaxWaitMs,
      }),
    );
    registered.push(QUEUES.whatsappOutbound.name);
  } else {
    logger?.warn(
      { event: 'worker.outbound_disabled', queue: QUEUES.whatsappOutbound.name },
      'Sem TOKEN_ENCRYPTION_KEYS nem WHATSAPP_API_TOKEN: whatsapp.outbound NÃO será processado (os jobs ficam esperando)',
    );
  }

  // T1.7: eco (validação ponta a ponta). Desligado por padrão; proibido em produção (config).
  if (config.echoEnabled) {
    await client.work(
      QUEUES.llmReply,
      createEchoReplyHandler({
        enqueueOutbound: (payload, options) =>
          client.enqueue(QUEUES.whatsappOutbound, payload, options),
      }),
    );
    registered.push(QUEUES.llmReply.name);
    logger?.warn({ event: 'worker.echo_enabled' }, 'ECO LIGADO: llm.reply responde "Eco: <texto>"');
  }

  // T2.2: ingestão da base de conhecimento (extrai, divide e gera embeddings).
  // Sem IA configurada o worker NÃO pega esses jobs: eles esperam na fila até a chave existir
  // (mesma ideia do envio sem token, acima).
  if (config.ai) {
    // Tokens e custo por tenant (T2.1) saem como linhas de métrica no log, como no resto do worker.
    const provider = createOpenAiProvider(config.ai, {
      ...(logger
        ? {
            logger,
            metrics: {
              increment: (name, labels, value = 1) =>
                logger.info({
                  event: 'metric',
                  metric: name,
                  metric_type: 'counter',
                  value,
                  ...labels,
                }),
              timing: (name, ms, labels) =>
                logger.info({
                  event: 'metric',
                  metric: name,
                  metric_type: 'timing',
                  value: ms,
                  ...labels,
                }),
            },
          }
        : {}),
    });
    await client.work(
      QUEUES.knowledgeIngest,
      createIngestKnowledgeHandler({
        storage: config.storage,
        embedder: provider,
        maxBytes: config.knowledge.maxBytes,
        embedBatchSize: config.knowledge.embedBatchSize,
        chunkOptions: {
          maxChars: config.knowledge.chunkMaxChars,
          overlapChars: config.knowledge.chunkOverlapChars,
        },
      }),
    );
    registered.push(QUEUES.knowledgeIngest.name);
  } else {
    logger?.warn(
      { event: 'worker.knowledge_disabled', queue: QUEUES.knowledgeIngest.name },
      'Sem OPENAI_API_KEY/AI_EMBEDDING_MODEL: knowledge.ingest NÃO será processado (os jobs ficam esperando)',
    );
  }

  return registered;
}
