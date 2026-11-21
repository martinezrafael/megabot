import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EmbedRequest, EmbedResult, EmbeddingProvider } from '@megabot/ai';
import type { KnowledgeSearchHit } from '@megabot/database';
import {
  DEFAULT_LIMITS,
  MAX_QUERY_CHARS,
  Retriever,
  estimateTokens,
  formatContext,
  type RetrieverLogger,
  type RetrieverMetrics,
  type SearchChunks,
} from '../src';

const PERGUNTA = 'Qual o prazo de entrega para o Nordeste?';
const SEGREDO = 'CONTEUDO-SECRETO-DO-TRECHO';

/** Embedder de mentira: registra as chamadas e devolve um vetor qualquer. */
function fakeEmbedder(over: Partial<EmbedResult> = {}) {
  const calls: EmbedRequest[] = [];
  const embedder: EmbeddingProvider = {
    name: 'fake',
    embed: async (request) => {
      calls.push(request);
      return {
        embeddings: request.input.map(() => Array.from({ length: 8 }, (_, i) => i / 10)),
        dimensions: 8,
        usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, totalTokens: 5 },
        costUsd: 0.000002,
        model: 'modelo-emb',
        ...over,
      };
    },
  };
  return { embedder, calls };
}

const hit = (over: Partial<KnowledgeSearchHit> = {}): KnowledgeSearchHit => ({
  chunkId: `chunk-${Math.random().toString(16).slice(2, 8)}`,
  sourceId: 'fonte-1',
  sourceTitle: 'Política de trocas',
  position: 0,
  content: 'Entregamos em todo o Brasil; capitais em 2 dias úteis.',
  heading: 'Entrega',
  similarity: 0.9,
  ...over,
});

/** Busca de mentira: devolve o que o teste mandar e guarda os parâmetros recebidos. */
function fakeSearch(hits: KnowledgeSearchHit[]) {
  const calls: Array<{ tenantId: string; embedding: readonly number[]; options: unknown }> = [];
  const search: SearchChunks = async (tenantId, embedding, options) => {
    calls.push({ tenantId, embedding, options });
    return hits.slice(0, options.limit);
  };
  return { search, calls };
}

function capture() {
  const logs: Array<Record<string, unknown>> = [];
  const logger: RetrieverLogger = {
    info: (fields) => void logs.push(fields),
    warn: (fields) => void logs.push(fields),
    error: (fields) => void logs.push(fields),
  };
  const increments: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  const timings: Array<{ name: string; ms: number }> = [];
  const metrics: RetrieverMetrics = {
    increment: (name, labels = {}, value = 1) => void increments.push({ name, labels, value }),
    timing: (name, ms) => void timings.push({ name, ms }),
  };
  return { logger, logs, metrics, increments, timings };
}

const build = (hits: KnowledgeSearchHit[], options: Record<string, unknown> = {}) => {
  const { embedder, calls: embedCalls } = fakeEmbedder();
  const { search, calls: searchCalls } = fakeSearch(hits);
  const captured = capture();
  const retriever = new Retriever({
    embedder,
    search,
    logger: captured.logger,
    metrics: captured.metrics,
    // Contador simples e previsível nos testes de lógica (o contador real tem o seu próprio teste).
    countTokens: estimateTokens,
    ...options,
  });
  return { retriever, embedCalls, searchCalls, ...captured };
};

describe('Retriever: caminho feliz', () => {
  it('embedda a pergunta, busca no tenant e devolve contexto numerado', async () => {
    const t = build([
      hit({ chunkId: 'c1', similarity: 0.92 }),
      hit({
        chunkId: 'c2',
        sourceId: 'fonte-2',
        sourceTitle: 'FAQ',
        heading: null,
        similarity: 0.71,
      }),
    ]);
    const result = await t.retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA });

    assert.equal(t.embedCalls.length, 1);
    assert.deepEqual(t.embedCalls[0]!.input, [PERGUNTA]);
    assert.equal(t.embedCalls[0]!.tenantId, 'tenant-1');
    assert.equal(t.embedCalls[0]!.dimensions, 1536, 'pede a dimensão que o banco aceita');

    assert.equal(t.searchCalls[0]!.tenantId, 'tenant-1');
    assert.deepEqual(t.searchCalls[0]!.options, {
      limit: DEFAULT_LIMITS.candidateLimit,
      minSimilarity: DEFAULT_LIMITS.minSimilarity,
    });

    assert.deepEqual(
      result.chunks.map((c) => c.chunkId),
      ['c1', 'c2'],
    );
    assert.equal(result.embeddingModel, 'modelo-emb');
    assert.equal(result.costUsd, 0.000002);
    assert.ok(result.tokens > 0);
    assert.equal(result.stats.candidates, 2);

    // Contexto: numerado, com fonte e seção, pronto para o prompt.
    assert.equal(
      result.context,
      [
        '[1] Política de trocas — Entrega',
        'Entregamos em todo o Brasil; capitais em 2 dias úteis.',
        '',
        '[2] FAQ',
        'Entregamos em todo o Brasil; capitais em 2 dias úteis.',
      ].join('\n'),
    );
  });

  it('pergunta gigante é cortada antes de virar embedding', async () => {
    const t = build([hit()]);
    await t.retriever.retrieve({ tenantId: 'tenant-1', query: 'a'.repeat(MAX_QUERY_CHARS + 500) });
    assert.equal(t.embedCalls[0]!.input[0]!.length, MAX_QUERY_CHARS);
  });

  it('repassa o sinal de cancelamento para o embedder', async () => {
    const controller = new AbortController();
    const t = build([hit()]);
    await t.retriever.retrieve({
      tenantId: 'tenant-1',
      query: PERGUNTA,
      signal: controller.signal,
    });
    assert.equal(t.embedCalls[0]!.signal, controller.signal);
  });
});

describe('Retriever: limites', () => {
  it('corta por similaridade mínima', async () => {
    const t = build(
      [hit({ chunkId: 'bom', similarity: 0.8 }), hit({ chunkId: 'fraco', similarity: 0.2 })],
      { limits: { minSimilarity: 0.5 } },
    );
    const result = await t.retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA });
    assert.deepEqual(
      result.chunks.map((c) => c.chunkId),
      ['bom'],
    );
    assert.equal(result.stats.belowThreshold, 1);
  });

  it('respeita o máximo de trechos', async () => {
    const hits = Array.from({ length: 10 }, (_, i) =>
      hit({ chunkId: `c${i}`, sourceId: `fonte-${i}`, similarity: 0.9 - i / 100 }),
    );
    const t = build(hits, { limits: { maxChunks: 3 } });
    const result = await t.retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA });
    assert.equal(result.chunks.length, 3);
    assert.equal(result.stats.droppedByBudget, 7);
  });

  it('limita trechos da mesma fonte (diversidade)', async () => {
    const hits = [
      hit({ chunkId: 'a1', sourceId: 'A', similarity: 0.95 }),
      hit({ chunkId: 'a2', sourceId: 'A', similarity: 0.94 }),
      hit({ chunkId: 'a3', sourceId: 'A', similarity: 0.93 }),
      hit({ chunkId: 'b1', sourceId: 'B', similarity: 0.6 }),
    ];
    const t = build(hits, { limits: { maxPerSource: 2 } });
    const result = await t.retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA });
    assert.deepEqual(
      result.chunks.map((c) => c.chunkId),
      ['a1', 'a2', 'b1'],
    );
    assert.equal(result.stats.droppedBySource, 1);
  });

  it('respeita o orçamento de tokens e ainda aproveita um trecho menor depois do grande', async () => {
    const grande = 'palavra '.repeat(200); // ~530 tokens estimados
    const pequeno = 'Frete grátis acima de R$ 199.';
    const t = build(
      [
        hit({ chunkId: 'grande', sourceId: 'A', content: grande, similarity: 0.9 }),
        hit({ chunkId: 'medio', sourceId: 'B', content: grande, similarity: 0.8 }),
        hit({ chunkId: 'pequeno', sourceId: 'C', content: pequeno, similarity: 0.7 }),
      ],
      { limits: { maxTokens: 600, maxChunkTokens: 400, maxChunks: 10 } },
    );
    const result = await t.retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA });

    assert.deepEqual(
      result.chunks.map((c) => c.chunkId),
      ['grande', 'pequeno'],
      'o segundo trecho grande não cabe, mas o pequeno sim',
    );
    assert.equal(result.chunks[0]?.truncated, true, 'o trecho grande foi cortado, não descartado');
    assert.ok(result.chunks[0]!.tokens <= 400);
    assert.ok(result.tokens <= 600, `contexto estourou: ${result.tokens}`);
    assert.equal(result.stats.truncated, 1);
    assert.equal(result.stats.droppedByBudget, 1);
  });

  it('limites podem ser trocados por chamada e valores absurdos são ajustados', async () => {
    const hits = Array.from({ length: 5 }, (_, i) => hit({ chunkId: `c${i}`, sourceId: `f${i}` }));
    const t = build(hits, { limits: { maxChunks: 5 } });

    const poucos = await t.retriever.retrieve({
      tenantId: 'tenant-1',
      query: PERGUNTA,
      limits: { maxChunks: 2 },
    });
    assert.equal(poucos.chunks.length, 2);

    // E a chamada seguinte volta ao limite do construtor.
    const todos = await t.retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA });
    assert.equal(todos.chunks.length, 5);

    const ajustado = await t.retriever.retrieve({
      tenantId: 'tenant-1',
      query: PERGUNTA,
      limits: { maxChunks: 0, minSimilarity: -3, maxTokens: 1 },
    });
    assert.ok(ajustado.chunks.length <= 1);
    // candidateLimit nunca fica menor que maxChunks.
    assert.ok((t.searchCalls.at(-1)!.options as { limit: number }).limit >= 1);
  });
});

describe('Retriever: nada encontrado e erros', () => {
  it('sem candidatos: resultado vazio, contexto vazio e métrica "empty"', async () => {
    const t = build([]);
    const result = await t.retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA });
    assert.deepEqual(result.chunks, []);
    assert.equal(result.context, '');
    assert.equal(result.tokens, 0);
    assert.ok(
      t.increments.some(
        (i) => i.name === 'retrieval_requests_total' && i.labels.outcome === 'empty',
      ),
    );
    assert.ok(t.logs.some((l) => l.event === 'retrieval.query' && l.outcome === 'empty'));
  });

  it('pergunta vazia nem chama o embedder', async () => {
    const t = build([hit()]);
    const result = await t.retriever.retrieve({ tenantId: 'tenant-1', query: '   ' });
    assert.deepEqual(result.chunks, []);
    assert.equal(t.embedCalls.length, 0);
    assert.equal(t.searchCalls.length, 0);
  });

  it('tenant obrigatório', async () => {
    const t = build([hit()]);
    await assert.rejects(t.retriever.retrieve({ tenantId: '', query: PERGUNTA }), /tenantId/);
    assert.equal(t.searchCalls.length, 0);
  });

  it('falha no embedding vira métrica de erro e o erro sobe para quem chamou', async () => {
    const captured = capture();
    const retriever = new Retriever({
      embedder: {
        name: 'quebrado',
        embed: async () => {
          throw new Error('provedor fora do ar');
        },
      },
      search: fakeSearch([hit()]).search,
      logger: captured.logger,
      metrics: captured.metrics,
      countTokens: estimateTokens,
    });
    await assert.rejects(
      retriever.retrieve({ tenantId: 'tenant-1', query: PERGUNTA }),
      /provedor fora do ar/,
    );
    assert.ok(
      captured.increments.some(
        (i) => i.name === 'retrieval_requests_total' && i.labels.outcome === 'error',
      ),
    );
    assert.ok(
      captured.logs.some((l) => l.event === 'retrieval.failed' && l.tenant_id === 'tenant-1'),
    );
  });
});

describe('Retriever: logs e métricas', () => {
  it('levam tenant_id e NUNCA a pergunta nem o conteúdo dos trechos', async () => {
    const t = build([
      hit({ chunkId: 'c1', content: SEGREDO, similarity: 0.9 }),
      hit({ chunkId: 'c2', sourceId: 'f2', content: SEGREDO, similarity: 0.1 }),
    ]);
    await t.retriever.retrieve({
      tenantId: 'tenant-42',
      query: `${PERGUNTA} MINHA-PERGUNTA-SECRETA`,
    });

    const log = t.logs.find((l) => l.event === 'retrieval.query')!;
    assert.equal(log.tenant_id, 'tenant-42');
    assert.equal(log.outcome, 'hit');
    assert.equal(log.returned, 1);
    assert.equal(log.candidates, 2);
    assert.equal(log.dropped_below_threshold, 1);
    assert.equal(typeof log.context_tokens, 'number');
    assert.equal(typeof log.latency_ms, 'number');
    assert.equal(log.top_similarity, 0.9);

    const tudo = JSON.stringify([t.logs, t.increments, t.timings]);
    assert.ok(!tudo.includes(SEGREDO), 'o conteúdo do trecho vazou');
    assert.ok(!tudo.includes('MINHA-PERGUNTA-SECRETA'), 'a pergunta vazou');

    assert.ok(t.increments.every((i) => i.labels.tenant_id === 'tenant-42'));
    assert.ok(
      t.increments.some((i) => i.name === 'retrieval_chunks_returned_total' && i.value === 1),
    );
    assert.ok(t.increments.some((i) => i.name === 'retrieval_context_tokens_total' && i.value > 0));
    assert.ok(
      t.increments.some(
        (i) => i.name === 'retrieval_chunks_dropped_total' && i.labels.reason === 'below_threshold',
      ),
    );
    assert.ok(t.timings.some((m) => m.name === 'retrieval_latency_ms'));
  });
});

describe('formatContext', () => {
  it('sem trechos devolve vazio', () => {
    assert.deepEqual(formatContext([], estimateTokens), { context: '', tokens: 0 });
  });
});
