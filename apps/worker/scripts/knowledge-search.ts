/**
 * Testa a busca na base de conhecimento de um tenant, com o provedor de IA de verdade.
 *
 *   pnpm --filter @megabot/worker knowledge:search -- --tenant <uuid> "qual o prazo de entrega?"
 *
 * Opções: --limite (trechos), --tokens (orçamento), --min (similaridade mínima), --por-fonte.
 * Serve para conferir relevância com o conteúdo real do cliente antes de ligar o agente.
 */
import { parseArgs } from 'node:util';
import { createOpenAiProvider } from '@megabot/ai';
import { prisma } from '@megabot/database';
import { Retriever } from '@megabot/retrieval';
import { loadWorkerConfig } from '../src/config';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tenant: { type: 'string' },
      limite: { type: 'string' },
      tokens: { type: 'string' },
      min: { type: 'string' },
      'por-fonte': { type: 'string' },
    },
  });

  const pergunta = positionals.join(' ').trim();
  if (!values.tenant || !pergunta) {
    console.error(
      'Uso: pnpm --filter @megabot/worker knowledge:search -- --tenant <uuid> "sua pergunta"',
    );
    process.exit(1);
  }

  const config = loadWorkerConfig();
  if (!config.ai) {
    console.error('Configure OPENAI_API_KEY, AI_CHAT_MODEL e AI_EMBEDDING_MODEL no .env.');
    process.exit(1);
  }

  const retriever = new Retriever({
    embedder: createOpenAiProvider(config.ai),
    limits: {
      ...config.retrieval,
      ...(values.limite ? { maxChunks: Number(values.limite) } : {}),
      ...(values.tokens ? { maxTokens: Number(values.tokens) } : {}),
      ...(values.min ? { minSimilarity: Number(values.min) } : {}),
      ...(values['por-fonte'] ? { maxPerSource: Number(values['por-fonte']) } : {}),
    },
  });

  const resultado = await retriever.retrieve({ tenantId: values.tenant, query: pergunta });

  console.info(`\nPergunta: ${pergunta}`);
  console.info(
    `Trechos: ${resultado.chunks.length} | tokens do contexto: ${resultado.tokens} | ` +
      `candidatos: ${resultado.stats.candidates} | ${resultado.latencyMs} ms | ` +
      `modelo: ${resultado.embeddingModel}` +
      (resultado.costUsd === null ? '' : ` | custo: US$ ${resultado.costUsd.toFixed(6)}`),
  );
  if (
    resultado.stats.belowThreshold ||
    resultado.stats.droppedBySource ||
    resultado.stats.droppedByBudget
  ) {
    console.info(
      `Descartados — pouco parecidos: ${resultado.stats.belowThreshold}, ` +
        `limite por fonte: ${resultado.stats.droppedBySource}, orçamento: ${resultado.stats.droppedByBudget}`,
    );
  }

  if (resultado.chunks.length === 0) {
    console.info('\nNada na base responde a isso (ou a similaridade ficou abaixo do mínimo).');
  } else {
    for (const [índice, chunk] of resultado.chunks.entries()) {
      console.info(
        `\n[${índice + 1}] ${chunk.sourceTitle}${chunk.heading ? ` — ${chunk.heading}` : ''} ` +
          `(similaridade ${chunk.similarity.toFixed(3)}, ${chunk.tokens} tokens${chunk.truncated ? ', cortado' : ''})`,
      );
      console.info(chunk.content);
    }
  }
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
