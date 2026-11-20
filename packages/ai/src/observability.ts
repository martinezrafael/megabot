/**
 * Contratos mínimos de log e métricas (mesma ideia do `@megabot/whatsapp`): o pacote NÃO depende de
 * pino nem de uma lib de métricas; quem usa (API/worker) injeta o que tem. O `pino` já serve.
 *
 * REGRA: nenhum log/métrica carrega o conteúdo das mensagens, os embeddings, a chave da API nem o
 * texto de erro devolvido pelo provedor (ele pode repetir trechos do prompt). Só ids, contagens e códigos.
 */
export type LogFields = Record<string, unknown>;

export interface AiLogger {
  debug?(fields: LogFields, message?: string): void;
  info(fields: LogFields, message?: string): void;
  warn(fields: LogFields, message?: string): void;
  error(fields: LogFields, message?: string): void;
}

export interface AiMetrics {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  timing(name: string, milliseconds: number, labels?: Record<string, string>): void;
}

export const noopLogger: AiLogger = { debug() {}, info() {}, warn() {}, error() {} };
export const noopMetrics: AiMetrics = { increment() {}, timing() {} };

/** Nomes das métricas emitidas (constantes para evitar erro de digitação nos dashboards). */
export const METRIC = {
  /** Rótulos: tenant_id, provider, model, operation, outcome (ok|error), error_category. */
  requests: 'ai_requests_total',
  requestDuration: 'ai_request_duration_ms',
  /** Rótulos: tenant_id, provider, model, operation, kind (input|cached_input|output). */
  tokens: 'ai_tokens_total',
  /** Custo estimado em USD. Rótulos: tenant_id, provider, model, operation. */
  costUsd: 'ai_cost_usd_total',
  retries: 'ai_retries_total',
} as const;
