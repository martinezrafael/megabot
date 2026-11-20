/**
 * Teste manual contra o provedor REAL (gasta alguns centavos de tokens):
 *   pnpm --filter @megabot/ai smoke
 * Precisa de OPENAI_API_KEY, AI_CHAT_MODEL e AI_EMBEDDING_MODEL no .env da raiz.
 * Imprime só contagens, custo e tempos: nunca a chave.
 */
import { z } from 'zod';
import {
  AiConfigError,
  AiError,
  METRIC,
  createOpenAiProvider,
  defineTool,
  loadAiConfig,
} from '../src';

const TENANT = 'smoke-test';

async function main() {
  const ai = createOpenAiProvider(loadAiConfig(), {
    logger: {
      info: (f, m) => console.info('LOG', m, JSON.stringify(f)),
      warn: (f, m) => console.warn('LOG', m, JSON.stringify(f)),
      error: (f, m) => console.error('LOG', m, JSON.stringify(f)),
    },
    metrics: {
      increment: (name, labels, value = 1) => {
        if (name === METRIC.tokens || name === METRIC.costUsd)
          console.info('METRICA', name, labels, value);
      },
      timing: () => undefined,
    },
  });

  console.info('\n1) Chat simples');
  const chat = await ai.generate({
    tenantId: TENANT,
    messages: [{ role: 'user', content: 'Responda apenas: pong' }],
    maxOutputTokens: 50,
  });
  console.info({ text: chat.text, usage: chat.usage, costUsd: chat.costUsd, model: chat.model });

  console.info('\n2) Tool calling tipado');
  const clima = defineTool({
    name: 'consultar_clima',
    description: 'Consulta o clima de uma cidade',
    parameters: z.object({ cidade: z.string() }),
  });
  const tool = await ai.generate({
    tenantId: TENANT,
    messages: [{ role: 'user', content: 'Qual o clima em São Paulo agora?' }],
    tools: [clima] as const,
    toolChoice: { name: 'consultar_clima' },
  });
  console.info({ toolCalls: tool.toolCalls, usage: tool.usage, costUsd: tool.costUsd });

  console.info('\n3) Embeddings');
  const emb = await ai.embed({ tenantId: TENANT, input: ['olá mundo', 'bom dia'] });
  console.info({
    vetores: emb.embeddings.length,
    dimensoes: emb.dimensions,
    usage: emb.usage,
    costUsd: emb.costUsd,
  });

  console.info('\nOK');
}

main().catch((error: unknown) => {
  if (error instanceof AiConfigError) console.error(error.message);
  else if (error instanceof AiError) {
    console.error(
      `Falhou: ${error.message} [categoria=${error.category}, repetível=${String(error.retryable)}]`,
    );
  } else console.error(error);
  process.exit(1);
});
