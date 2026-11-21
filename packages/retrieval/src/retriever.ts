import { KNOWLEDGE_EMBEDDING_DIMENSIONS, searchKnowledgeChunks } from '@megabot/database';
import { loadTokenCounter, truncateToTokens, type TokenCounter } from './tokens';
import {
  DEFAULT_LIMITS,
  type RetrievalLimits,
  type RetrievalResult,
  type RetrievalStats,
  type RetrieveRequest,
  type RetrievedChunk,
  type RetrieverOptions,
  type SearchChunks,
} from './types';

/**
 * Retriever (T2.3): dada a pergunta do cliente, devolve os trechos da base **daquele tenant** que
 * mais se parecem com ela, já dentro de um orçamento de quantidade e de tokens.
 *
 * O caminho é sempre o mesmo:
 *
 *   pergunta → embedding → busca vetorial (RLS por tenant) → corte por relevância
 *            → diversidade por fonte → orçamento de tokens → contexto numerado para o prompt
 *
 * Três garantias que valem destacar:
 *  - **Isolamento:** o `tenantId` é obrigatório e a busca roda dentro de `withTenant` (RLS no banco).
 *    Não existe caminho que leia a base de outra empresa, nem com o mesmo vetor.
 *  - **Orçamento real:** os tokens são contados com o tokenizador, não estimados por caracteres.
 *  - **Privacidade:** nem a pergunta nem o conteúdo dos trechos entram em log ou métrica.
 */
export const RETRIEVAL_METRIC = {
  /** Rótulos: tenant_id, outcome (hit|empty|error). */
  requests: 'retrieval_requests_total',
  chunks: 'retrieval_chunks_returned_total',
  tokens: 'retrieval_context_tokens_total',
  latency: 'retrieval_latency_ms',
  /** Rótulos: tenant_id, reason (below_threshold|per_source|budget). */
  dropped: 'retrieval_chunks_dropped_total',
} as const;

/** Tamanho máximo da pergunta considerado na busca (o resto é ignorado). */
export const MAX_QUERY_CHARS = 2000;

export class Retriever {
  private readonly search: SearchChunks;
  private readonly limits: RetrievalLimits;
  private readonly options: RetrieverOptions;
  private counter: TokenCounter | undefined;

  constructor(options: RetrieverOptions) {
    this.options = options;
    this.search = options.search ?? (searchKnowledgeChunks as SearchChunks);
    this.limits = resolveLimits(DEFAULT_LIMITS, options.limits);
    this.counter = options.countTokens;
  }

  private async tokenCounter(): Promise<TokenCounter> {
    this.counter ??= await loadTokenCounter(this.options.encoding ?? 'o200k_base');
    return this.counter;
  }

  async retrieve(request: RetrieveRequest): Promise<RetrievalResult> {
    const { tenantId } = request;
    if (!tenantId?.trim()) throw new Error('tenantId é obrigatório na busca da base.');

    const limits = resolveLimits(this.limits, request.limits);
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    const query = request.query.trim().slice(0, MAX_QUERY_CHARS);
    const count = await this.tokenCounter();

    if (!query) {
      return this.finish(tenantId, startedAt, now, emptyResult('nenhum', null), 'empty');
    }

    let embedding: number[];
    let embeddingModel = 'desconhecido';
    let costUsd: number | null = null;
    try {
      const embedded = await this.options.embedder.embed({
        tenantId,
        input: [query],
        dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      embedding = embedded.embeddings[0] ?? [];
      embeddingModel = embedded.model;
      costUsd = embedded.costUsd;
    } catch (error) {
      this.options.metrics?.increment(RETRIEVAL_METRIC.requests, {
        tenant_id: tenantId,
        outcome: 'error',
      });
      this.options.logger?.error(
        { event: 'retrieval.failed', tenant_id: tenantId, step: 'embedding' },
        'Falha ao gerar o embedding da pergunta',
      );
      throw error;
    }

    const candidates = await this.search(tenantId, embedding, {
      limit: limits.candidateLimit,
      minSimilarity: limits.minSimilarity,
    });

    const { chunks, stats } = selectChunks(candidates, limits, count);
    const { context, tokens } = formatContext(chunks, count);

    const result: RetrievalResult = {
      chunks,
      context,
      tokens,
      stats: { ...stats, candidates: candidates.length },
      embeddingModel,
      costUsd,
      latencyMs: 0,
    };
    return this.finish(tenantId, startedAt, now, result, chunks.length > 0 ? 'hit' : 'empty');
  }

  /** Fecha a medição, registra log e métricas (sempre com tenant_id, nunca com conteúdo). */
  private finish(
    tenantId: string,
    startedAt: number,
    now: () => number,
    result: RetrievalResult,
    outcome: 'hit' | 'empty',
  ): RetrievalResult {
    const latencyMs = now() - startedAt;
    const final = { ...result, latencyMs };
    const { metrics, logger } = this.options;

    metrics?.increment(RETRIEVAL_METRIC.requests, { tenant_id: tenantId, outcome });
    metrics?.increment(RETRIEVAL_METRIC.chunks, { tenant_id: tenantId }, final.chunks.length);
    metrics?.increment(RETRIEVAL_METRIC.tokens, { tenant_id: tenantId }, final.tokens);
    metrics?.timing?.(RETRIEVAL_METRIC.latency, latencyMs, { tenant_id: tenantId });
    for (const [reason, value] of [
      ['below_threshold', final.stats.belowThreshold],
      ['per_source', final.stats.droppedBySource],
      ['budget', final.stats.droppedByBudget],
    ] as const) {
      if (value > 0) {
        metrics?.increment(RETRIEVAL_METRIC.dropped, { tenant_id: tenantId, reason }, value);
      }
    }

    logger?.info(
      {
        event: 'retrieval.query',
        tenant_id: tenantId,
        outcome,
        candidates: final.stats.candidates,
        returned: final.chunks.length,
        context_tokens: final.tokens,
        // Só a nota do melhor trecho: ajuda a calibrar o corte sem revelar conteúdo.
        top_similarity: final.chunks[0] ? Number(final.chunks[0].similarity.toFixed(3)) : null,
        dropped_below_threshold: final.stats.belowThreshold,
        dropped_per_source: final.stats.droppedBySource,
        dropped_by_budget: final.stats.droppedByBudget,
        truncated: final.stats.truncated,
        embedding_model: final.embeddingModel,
        cost_usd: final.costUsd,
        latency_ms: latencyMs,
      },
      outcome === 'hit' ? 'Busca na base de conhecimento' : 'Busca na base sem resultado',
    );
    return final;
  }
}

function resolveLimits(base: RetrievalLimits, over?: Partial<RetrievalLimits>): RetrievalLimits {
  const merged = { ...base, ...removeUndefined(over ?? {}) };
  return {
    maxChunks: clampInt(merged.maxChunks, 1, 50),
    maxTokens: clampInt(merged.maxTokens, 50, 100_000),
    // Fracionário de propósito: 0,35 é um limiar, não uma contagem (arredondar aqui desligaria o corte).
    minSimilarity: clampFloat(merged.minSimilarity, 0, 1),
    maxPerSource: clampInt(merged.maxPerSource, 1, 50),
    // Sempre pelo menos tantos candidatos quanto trechos pedidos.
    candidateLimit: clampInt(Math.max(merged.candidateLimit, merged.maxChunks), 1, 200),
    maxChunkTokens: clampInt(merged.maxChunkTokens, 20, merged.maxTokens),
  };
}

const clampFloat = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;

const clampInt = (value: number, min: number, max: number) =>
  clampFloat(Math.round(value), min, max);

const removeUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

const emptyResult = (embeddingModel: string, costUsd: number | null): RetrievalResult => ({
  chunks: [],
  context: '',
  tokens: 0,
  stats: { candidates: 0, belowThreshold: 0, droppedBySource: 0, droppedByBudget: 0, truncated: 0 },
  embeddingModel,
  costUsd,
  latencyMs: 0,
});

/**
 * Escolhe quais candidatos entram, nesta ordem: relevância (já ordenada pelo banco), diversidade
 * por fonte e orçamento de tokens. Um trecho grande demais é cortado em vez de descartado — ele é
 * justamente o mais parecido com a pergunta.
 */
export function selectChunks(
  candidates: ReadonlyArray<{
    chunkId: string;
    sourceId: string;
    sourceTitle: string;
    position: number;
    content: string;
    heading: string | null;
    similarity: number;
  }>,
  limits: RetrievalLimits,
  count: TokenCounter,
): { chunks: RetrievedChunk[]; stats: RetrievalStats } {
  const stats: RetrievalStats = {
    candidates: candidates.length,
    belowThreshold: 0,
    droppedBySource: 0,
    droppedByBudget: 0,
    truncated: 0,
  };
  const perSource = new Map<string, number>();
  const chunks: RetrievedChunk[] = [];
  let used = 0;

  for (const candidate of candidates) {
    if (chunks.length >= limits.maxChunks) {
      stats.droppedByBudget += 1;
      continue;
    }
    if (candidate.similarity < limits.minSimilarity) {
      stats.belowThreshold += 1;
      continue;
    }
    const fromSource = perSource.get(candidate.sourceId) ?? 0;
    if (fromSource >= limits.maxPerSource) {
      stats.droppedBySource += 1;
      continue;
    }

    const { text, tokens, truncated } = truncateToTokens(
      candidate.content,
      limits.maxChunkTokens,
      count,
    );
    // Cada trecho leva um rótulo de citação no contexto; reserva alguns tokens para ele.
    const withLabel = tokens + LABEL_TOKENS;
    if (used + withLabel > limits.maxTokens) {
      stats.droppedByBudget += 1;
      continue; // segue tentando: um trecho menor adiante ainda pode caber
    }

    used += withLabel;
    if (truncated) stats.truncated += 1;
    perSource.set(candidate.sourceId, fromSource + 1);
    chunks.push({
      chunkId: candidate.chunkId,
      sourceId: candidate.sourceId,
      sourceTitle: candidate.sourceTitle,
      heading: candidate.heading,
      content: text,
      similarity: candidate.similarity,
      tokens,
      truncated,
    });
  }

  return { chunks, stats };
}

/** Tokens reservados para o rótulo `[n] Título — Seção` de cada trecho. */
const LABEL_TOKENS = 12;

/**
 * Monta o texto que vai para o prompt. Cada trecho é numerado e identificado pela fonte, para o
 * agente poder citar ("segundo a Política de trocas...") e para a pessoa conferir a origem.
 */
export function formatContext(
  chunks: readonly RetrievedChunk[],
  count: TokenCounter,
): { context: string; tokens: number } {
  if (chunks.length === 0) return { context: '', tokens: 0 };
  const context = chunks
    .map((chunk, index) => {
      const titulo = chunk.heading ? `${chunk.sourceTitle} — ${chunk.heading}` : chunk.sourceTitle;
      return `[${index + 1}] ${titulo}\n${chunk.content}`;
    })
    .join('\n\n');
  return { context, tokens: count(context) };
}
