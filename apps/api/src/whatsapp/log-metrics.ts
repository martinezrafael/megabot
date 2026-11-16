import type { WhatsAppLogger, WhatsAppMetrics } from '@megabot/whatsapp';
import type { PinoLogger } from 'nestjs-pino';

/** Adapta o PinoLogger (do Nest) ao contrato de log do pacote @megabot/whatsapp. */
export function toWhatsAppLogger(logger: PinoLogger): WhatsAppLogger {
  return {
    debug: (fields, message) => logger.debug(fields, message),
    info: (fields, message) => logger.info(fields, message),
    warn: (fields, message) => logger.warn(fields, message),
    error: (fields, message) => logger.error(fields, message),
  };
}

/**
 * Métricas como linhas de log estruturadas (`event: "metric"`).
 *
 * Ainda não temos Prometheus/OpenTelemetry: este adaptador deixa as métricas consultáveis
 * no mesmo pipeline dos logs, com `tenant_id`. Quando houver um coletor, basta trocar esta
 * função por outra que implemente `WhatsAppMetrics` (increment/timing), sem mexer no resto.
 */
export function createLogMetrics(logger: PinoLogger): WhatsAppMetrics {
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

/** Nomes das métricas do webhook de entrada. */
export const WEBHOOK_METRIC = {
  requests: 'whatsapp_webhook_requests_total',
  eventsReceived: 'whatsapp_webhook_events_received_total',
  eventsStored: 'whatsapp_webhook_events_stored_total',
  eventsDuplicate: 'whatsapp_webhook_events_duplicate_total',
  unknownNumber: 'whatsapp_webhook_unknown_number_total',
  duration: 'whatsapp_webhook_duration_ms',
} as const;
