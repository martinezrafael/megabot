/**
 * Contratos mínimos de log e métricas (mesmo formato do @megabot/whatsapp).
 *
 * O pacote NÃO depende de pino: quem usa (worker/API) injeta o que tem. O `pino` já satisfaz
 * `QueueLogger` (assinatura `logger.info(objeto, mensagem)`).
 */
export type LogFields = Record<string, unknown>;

export interface QueueLogger {
  debug?(fields: LogFields, message?: string): void;
  info(fields: LogFields, message?: string): void;
  warn(fields: LogFields, message?: string): void;
  error(fields: LogFields, message?: string): void;
}

export interface QueueMetrics {
  /** Soma `value` (padrão 1) a um contador. */
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  /** Registra uma duração em milissegundos (histograma/summary). */
  timing(name: string, milliseconds: number, labels?: Record<string, string>): void;
}

export const noopLogger: QueueLogger = { debug() {}, info() {}, warn() {}, error() {} };
export const noopMetrics: QueueMetrics = { increment() {}, timing() {} };

/** Nomes das métricas emitidas (constantes para evitar erro de digitação nos dashboards). */
export const METRIC = {
  enqueued: 'queue_jobs_enqueued_total',
  processed: 'queue_jobs_processed_total',
  duration: 'queue_job_duration_ms',
} as const;

/**
 * Métricas como linhas de log estruturadas (`event: "metric"`), com os rótulos (inclusive `tenant_id`).
 * Enquanto não existe Prometheus/OpenTelemetry, as métricas viajam pelo mesmo pipeline dos logs.
 * Quando houver um coletor, troque por outra implementação de `QueueMetrics`.
 */
export function createLogMetrics(logger: Pick<QueueLogger, 'info'>): QueueMetrics {
  return {
    increment: (name, labels, value = 1) =>
      logger.info({ event: 'metric', metric: name, metric_type: 'counter', value, ...labels }),
    timing: (name, milliseconds, labels) =>
      logger.info({
        event: 'metric',
        metric: name,
        metric_type: 'timing_ms',
        value: milliseconds,
        ...labels,
      }),
  };
}
