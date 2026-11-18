/**
 * Logs e métricas dos repositórios de conversas (mesmo contrato dos pacotes whatsapp e queue).
 * Opcionais: sem eles, nada é emitido. TODO evento carrega `tenant_id`.
 * Nunca vão para o log: texto das mensagens, nome do contato e número completo (só ids internos).
 */
export type LogFields = Record<string, unknown>;

export interface ConversationLogger {
  info(fields: LogFields, message?: string): void;
  warn(fields: LogFields, message?: string): void;
}

export interface ConversationMetrics {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
}

export interface ConversationObservability {
  logger?: ConversationLogger;
  metrics?: ConversationMetrics;
}

export const CONVERSATION_METRIC = {
  /** Uma janela de 24h foi aberta (base da cota, ADR 0011). Rótulo: tenant_id. */
  windowOpened: 'conversation_windows_opened_total',
  /** Janela renovada por nova mensagem do contato. */
  windowRenewed: 'conversation_windows_renewed_total',
  /** Janelas marcadas como expiradas pela varredura. */
  windowExpired: 'conversation_windows_expired_total',
  /** Mensagens gravadas. Rótulos: tenant_id, direction, outcome (created|duplicate). */
  messages: 'conversation_messages_total',
  /** Envio livre recusado por janela fechada. */
  outboundBlocked: 'conversation_outbound_blocked_total',
  /** Atualização de status. Rótulos: tenant_id, status, outcome (updated|ignored|not_found). */
  statusUpdates: 'conversation_status_updates_total',
} as const;

/** Métricas como linhas de log (`event: "metric"`), igual ao T1.2/T1.3. */
export function createLogMetrics(logger: Pick<ConversationLogger, 'info'>): ConversationMetrics {
  return {
    increment: (name, labels, value = 1) =>
      logger.info({ event: 'metric', metric: name, metric_type: 'counter', value, ...labels }),
  };
}
