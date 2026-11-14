/**
 * Contratos mínimos de log e métricas.
 *
 * O pacote NÃO depende de pino nem de uma lib de métricas: quem usa (API/worker) injeta o que tem.
 * O `pino` já satisfaz `WhatsAppLogger` (assinatura `logger.info(objeto, mensagem)`).
 */
export type LogFields = Record<string, unknown>;

export interface WhatsAppLogger {
  debug?(fields: LogFields, message?: string): void;
  info(fields: LogFields, message?: string): void;
  warn(fields: LogFields, message?: string): void;
  error(fields: LogFields, message?: string): void;
}

export interface WhatsAppMetrics {
  /** Soma `value` (padrão 1) a um contador. */
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  /** Registra uma duração em milissegundos (histograma/summary). */
  timing(name: string, milliseconds: number, labels?: Record<string, string>): void;
}

export const noopLogger: WhatsAppLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const noopMetrics: WhatsAppMetrics = {
  increment() {},
  timing() {},
};

/** Nomes das métricas emitidas (constantes para evitar erro de digitação nos dashboards). */
export const METRIC = {
  requests: 'whatsapp_api_requests_total',
  requestDuration: 'whatsapp_api_request_duration_ms',
  webhookEvents: 'whatsapp_webhook_events_total',
  webhookInvalid: 'whatsapp_webhook_invalid_total',
} as const;

/** Mostra só os 4 últimos dígitos: logs ajudam a depurar sem expor o telefone do cliente. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `***${digits.slice(-4)}`;
}
