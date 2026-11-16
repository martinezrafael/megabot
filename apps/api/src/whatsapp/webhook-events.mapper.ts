import { randomUUID } from 'node:crypto';
import type { NewWebhookEvent } from '@megabot/database';
import type { WebhookEvent } from '@megabot/whatsapp';

/**
 * Converte um evento já interpretado (pacote @megabot/whatsapp) na linha de `webhook_events`.
 *
 * A CHAVE DE IDEMPOTÊNCIA (`eventKey`) decide o que é "o mesmo evento":
 * - mensagem recebida: `message:<wamid>`. Cada mensagem tem um wamid único.
 * - status de envio:   `status:<wamid>:<status>`. O MESMO wamid recebe vários status
 *                      (sent, delivered, read), então o status entra na chave.
 * - erro de sistema:   não tem identificador; cada um é gravado (chave aleatória).
 */
export function toNewWebhookEvent(event: WebhookEvent, now: Date = new Date()): NewWebhookEvent {
  // Datas viram texto ISO e o resultado é JSON puro (é o que o Postgres guarda em jsonb).
  const payload = JSON.parse(JSON.stringify(event)) as NewWebhookEvent['payload'];

  switch (event.kind) {
    case 'message':
      return {
        eventKey: `message:${event.id}`,
        kind: 'message',
        phoneNumberId: event.phoneNumberId,
        wamid: event.id,
        eventAt: event.timestamp,
        payload,
      };
    case 'status':
      return {
        eventKey: `status:${event.messageId}:${event.status}`,
        kind: 'status',
        phoneNumberId: event.phoneNumberId,
        wamid: event.messageId,
        status: event.status,
        eventAt: event.timestamp,
        payload,
      };
    case 'error':
      return {
        eventKey: `error:${randomUUID()}`,
        kind: 'error',
        phoneNumberId: event.phoneNumberId,
        eventAt: now,
        payload,
      };
  }
}

/** Agrupa os eventos pelo número de WhatsApp da empresa (cada número pertence a um tenant). */
export function groupByPhoneNumber(events: WebhookEvent[]): Map<string, WebhookEvent[]> {
  const groups = new Map<string, WebhookEvent[]>();
  for (const event of events) {
    const group = groups.get(event.phoneNumberId);
    if (group) group.push(event);
    else groups.set(event.phoneNumberId, [event]);
  }
  return groups;
}
