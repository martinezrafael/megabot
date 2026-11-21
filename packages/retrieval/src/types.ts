import type { EmbeddingProvider } from '@megabot/ai';
import type { KnowledgeSearchHit } from '@megabot/database';
import type { TokenCounter, TokenEncoding } from './tokens';

/** Limites da recuperação. Todos configuráveis por chamada ou na construção do Retriever. */
export interface RetrievalLimits {
  /** Máximo de trechos devolvidos. */
  maxChunks: number;
  /** Orçamento de tokens do contexto montado (a soma dos trechos + os rótulos de citação). */
  maxTokens: number;
  /** Similaridade mínima (0 a 1) para um trecho ser considerado relevante. */
  minSimilarity: number;
  /** Máximo de trechos vindos da MESMA fonte (evita uma fonte dominar a resposta). */
  maxPerSource: number;
  /** Quantos candidatos pedir ao banco antes de filtrar (dá margem para os cortes). */
  candidateLimit: number;
  /** Um trecho maior que isto é cortado (em vez de descartado). */
  maxChunkTokens: number;
}

export const DEFAULT_LIMITS: RetrievalLimits = {
  maxChunks: 6,
  maxTokens: 1200,
  minSimilarity: 0.35,
  maxPerSource: 3,
  candidateLimit: 24,
  maxChunkTokens: 600,
};

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  /** Texto do trecho (já cortado, se tiver passado de `maxChunkTokens`). */
  content: string;
  /** 1 = idêntico à pergunta; 0 = sem relação. */
  similarity: number;
  tokens: number;
  truncated: boolean;
}

/** Por que cada candidato ficou de fora — é o que explica "por que o bot não citou aquele trecho". */
export interface RetrievalStats {
  candidates: number;
  belowThreshold: number;
  droppedBySource: number;
  droppedByBudget: number;
  truncated: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Contexto pronto para entrar no prompt (vazio quando nada passou nos filtros). */
  context: string;
  /** Tokens do `context` (contados, não estimados). */
  tokens: number;
  stats: RetrievalStats;
  /** Modelo que gerou o embedding da pergunta. */
  embeddingModel: string;
  /** Custo estimado da chamada de embedding da pergunta (null se o modelo não tem preço). */
  costUsd: number | null;
  latencyMs: number;
}

export interface RetrieveRequest {
  tenantId: string;
  /** A pergunta do cliente, como ela chegou. */
  query: string;
  limits?: Partial<RetrievalLimits>;
  signal?: AbortSignal;
}

/** Assinatura da busca no banco (injetável para testar sem Postgres). */
export type SearchChunks = (
  tenantId: string,
  embedding: readonly number[],
  options: { limit: number; minSimilarity: number },
) => Promise<KnowledgeSearchHit[]>;

export interface RetrieverLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface RetrieverMetrics {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  timing?(name: string, milliseconds: number, labels?: Record<string, string>): void;
}

export interface RetrieverOptions {
  /** Quem transforma a pergunta em vetor (pacote `@megabot/ai`). */
  embedder: EmbeddingProvider;
  /** Padrão: `searchKnowledgeChunks` do `@megabot/database` (com RLS por tenant). */
  search?: SearchChunks;
  limits?: Partial<RetrievalLimits>;
  logger?: RetrieverLogger;
  metrics?: RetrieverMetrics;
  /** Contador de tokens. Padrão: tokenizador real, carregado sob demanda. */
  countTokens?: TokenCounter;
  encoding?: TokenEncoding;
  now?: () => number;
}
