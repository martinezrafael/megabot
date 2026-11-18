/** Nomes das métricas dos jobs que processam eventos do webhook (T1.5 e T1.6). */
export const INBOUND_METRIC = {
  /** Eventos processados. Rótulos: tenant_id, kind, outcome. */
  events: 'inbound_events_total',
  /** Decisão de acionar o agente. Rótulos: tenant_id, trigger (true|false), reason. */
  decisions: 'inbound_agent_decisions_total',
} as const;
