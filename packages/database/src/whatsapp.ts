import { Prisma } from './generated/prisma/client';
import { prisma } from './client';
import { withTenant } from './tenant-helper';

/** `phone_number_id` da Meta é numérico (ex.: 106540352242922). Qualquer outra coisa nem consulta o banco. */
const PHONE_NUMBER_ID = /^\d{1,32}$/;

export interface WhatsappConnectionInfo {
  tenantId: string;
  wabaId: string;
}

/**
 * Descobre de qual tenant é um número do WhatsApp.
 *
 * É o ÚNICO ponto em que lemos `whatsapp_connections` sem saber o tenant: o webhook só traz
 * o `phone_number_id`. A policy `whatsapp_connection_lookup_policy` libera o SELECT de UMA
 * linha (a do número informado em `app.phone_number_id`).
 */
export async function findWhatsappConnectionByPhoneNumberId(
  phoneNumberId: string,
): Promise<WhatsappConnectionInfo | null> {
  if (!PHONE_NUMBER_ID.test(phoneNumberId)) return null;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.phone_number_id', ${phoneNumberId}, true)`;
    const connection = await tx.whatsappConnection.findUnique({
      where: { phoneNumberId },
      select: { tenantId: true, wabaId: true },
    });
    return connection;
  });
}

export interface RegisterWhatsappConnectionInput {
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber?: string;
}

/**
 * Liga um número do WhatsApp a um tenant (idempotente para o MESMO tenant).
 * Se o número já pertence a OUTRO tenant, falha (o número é único no sistema).
 */
export async function registerWhatsappConnection(
  tenantId: string,
  input: RegisterWhatsappConnectionInput,
) {
  if (!PHONE_NUMBER_ID.test(input.phoneNumberId)) {
    throw new Error('phoneNumberId inválido: use só dígitos (ex.: 106540352242922).');
  }
  return withTenant(tenantId, (tx) =>
    tx.whatsappConnection.upsert({
      where: { phoneNumberId: input.phoneNumberId },
      create: {
        tenantId,
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        displayPhoneNumber: input.displayPhoneNumber ?? null,
      },
      update: {
        wabaId: input.wabaId,
        displayPhoneNumber: input.displayPhoneNumber ?? null,
      },
    }),
  );
}

export interface NewWebhookEvent {
  /** Chave de idempotência (única por tenant). Ex.: `message:wamid...` ou `status:wamid...:read`. */
  eventKey: string;
  kind: 'message' | 'status' | 'error';
  phoneNumberId: string;
  wamid?: string | undefined;
  status?: string | undefined;
  /** Quando o evento aconteceu segundo a Meta (define a ordem real, não a de chegada). */
  eventAt: Date;
  payload: Prisma.InputJsonValue;
}

export interface StoreWebhookEventsResult {
  received: number;
  inserted: number;
  duplicates: number;
}

/**
 * Grava os eventos do webhook como `pending`. Eventos repetidos (mesma `eventKey` no tenant)
 * são ignorados pelo banco (`ON CONFLICT DO NOTHING`), então reenvio da Meta é seguro.
 * Tudo numa transação com o tenant definido (RLS).
 */
export async function storeWebhookEvents(
  tenantId: string,
  events: NewWebhookEvent[],
): Promise<StoreWebhookEventsResult> {
  if (events.length === 0) return { received: 0, inserted: 0, duplicates: 0 };

  const result = await withTenant(tenantId, (tx) =>
    tx.webhookEvent.createMany({
      data: events.map((event) => ({
        tenantId,
        phoneNumberId: event.phoneNumberId,
        eventKey: event.eventKey,
        kind: event.kind,
        wamid: event.wamid ?? null,
        status: event.status ?? null,
        eventAt: event.eventAt,
        payload: event.payload,
      })),
      skipDuplicates: true,
    }),
  );
  return {
    received: events.length,
    inserted: result.count,
    duplicates: events.length - result.count,
  };
}

export interface WebhookEventRecord {
  id: string;
  tenantId: string;
  kind: string;
  wamid: string | null;
  status: string | null;
  eventAt: Date;
  receivedAt: Date;
  payload: Prisma.JsonValue;
  processStatus: string;
}

/** Lê um evento da caixa de entrada (T1.5). `null` se não existe NESTE tenant (RLS). */
export function getWebhookEvent(
  tenantId: string,
  eventId: string,
): Promise<WebhookEventRecord | null> {
  return withTenant(tenantId, (tx) =>
    tx.webhookEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        tenantId: true,
        kind: true,
        wamid: true,
        status: true,
        eventAt: true,
        receivedAt: true,
        payload: true,
        processStatus: true,
      },
    }),
  );
}

/**
 * Marca o fim do processamento de um evento: `processed` ou `failed`.
 * Só sai de `pending` (ou de `failed`, para reprocessar); um evento `processed` não muda mais.
 */
export async function markWebhookEvent(
  tenantId: string,
  eventId: string,
  processStatus: 'processed' | 'failed',
  now: Date = new Date(),
): Promise<boolean> {
  const result = await withTenant(tenantId, (tx) =>
    tx.webhookEvent.updateMany({
      where: { id: eventId, tenantId, processStatus: { not: 'processed' } },
      data: { processStatus, processedAt: now },
    }),
  );
  return result.count > 0;
}

/** Ids dos eventos ainda `pending` de um tenant, do mais antigo ao mais novo (para reprocessar). */
export function listPendingWebhookEventIds(tenantId: string, limit = 500): Promise<string[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.webhookEvent.findMany({
      where: { tenantId, processStatus: 'pending' },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  });
}

export interface PendingWebhookEvent {
  id: string;
  kind: string;
}

/** Como `listPendingWebhookEventIds`, mas com o tipo do evento (para escolher a fila certa). */
export function listPendingWebhookEvents(
  tenantId: string,
  limit = 500,
): Promise<PendingWebhookEvent[]> {
  return withTenant(tenantId, (tx) =>
    tx.webhookEvent.findMany({
      where: { tenantId, processStatus: 'pending' },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true, kind: true },
    }),
  );
}
