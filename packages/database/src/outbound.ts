import { Prisma } from './generated/prisma/client';
import { withTenant } from './tenant-helper';

/**
 * Apoio ao envio de mensagens (T1.6): ler a mensagem a enviar, achar o número do tenant e
 * controlar a vazão por número (balde de fichas no Postgres, valendo para todos os workers).
 */

// ---------------------------------------------------------------------------
// Mensagem a enviar
// ---------------------------------------------------------------------------

export interface OutboundMessageForSend {
  id: string;
  contactId: string;
  /** Número do contato (só dígitos): é o destinatário na Meta. */
  waId: string;
  conversationId: string | null;
  sender: string;
  type: string;
  body: string | null;
  content: Prisma.JsonValue;
  status: string;
  wamid: string | null;
}

/** Lê uma mensagem de SAÍDA com o número do contato. `null` se não existe neste tenant (RLS). */
export function getOutboundMessageForSend(
  tenantId: string,
  messageId: string,
): Promise<OutboundMessageForSend | null> {
  return withTenant(tenantId, async (tx) => {
    const message = await tx.message.findFirst({
      where: { id: messageId, tenantId, direction: 'outbound' },
      select: {
        id: true,
        contactId: true,
        conversationId: true,
        sender: true,
        type: true,
        body: true,
        content: true,
        status: true,
        wamid: true,
        contact: { select: { waId: true } },
      },
    });
    if (!message) return null;
    const { contact, ...rest } = message;
    return { ...rest, waId: contact.waId };
  });
}

// ---------------------------------------------------------------------------
// Número do WhatsApp do tenant
// ---------------------------------------------------------------------------

export interface TenantWhatsappNumber {
  phoneNumberId: string;
  wabaId: string;
}

/**
 * Número usado para enviar. MVP: um número por tenant. Se houver mais de um, vale o mais antigo
 * (decisão de produto pendente: a mensagem ainda não guarda por qual número a conversa chegou).
 */
export function findTenantWhatsappNumber(tenantId: string): Promise<TenantWhatsappNumber | null> {
  return withTenant(tenantId, (tx) =>
    tx.whatsappConnection.findFirst({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { phoneNumberId: 'asc' }],
      select: { phoneNumberId: true, wabaId: true },
    }),
  );
}

// ---------------------------------------------------------------------------
// Rate limit por número (balde de fichas)
// ---------------------------------------------------------------------------

export interface SendTokenOptions {
  /** Fichas devolvidas por segundo (= mensagens por segundo permitidas). */
  ratePerSecond: number;
  /** Tamanho do balde (rajada máxima). Padrão: igual a `ratePerSecond`. */
  burst?: number;
  now?: Date;
}

export type SendTokenResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Tenta pegar UMA ficha do balde do número. Atômico: vários workers ao mesmo tempo nunca passam
 * do limite. Sem ficha, diz em quantos ms haverá uma.
 *
 * Funcionamento: `tokens` = fichas na hora `refilled_at`. Agora há
 * `min(burst, tokens + segundos_passados × ratePerSecond)`; se for ≥ 1, gasta 1.
 */
export async function takeWhatsappSendToken(
  tenantId: string,
  phoneNumberId: string,
  options: SendTokenOptions,
): Promise<SendTokenResult> {
  const rate = options.ratePerSecond;
  if (!(rate > 0)) throw new Error('ratePerSecond precisa ser maior que 0.');
  const burst = options.burst ?? Math.max(1, rate);
  if (!(burst >= 1)) throw new Error('burst precisa ser pelo menos 1.');
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    // Primeira vez: cria o balde cheio já gastando 1. Depois: reabastece e gasta, mas SÓ se houver ficha.
    const granted = await tx.$queryRaw<Array<{ tokens: number }>>(Prisma.sql`
      INSERT INTO whatsapp_rate_limits (phone_number_id, tenant_id, tokens, refilled_at)
      VALUES (${phoneNumberId}, ${tenantId}::uuid, ${burst - 1}, ${now})
      ON CONFLICT (phone_number_id) DO UPDATE SET
        tokens = LEAST(
          ${burst}::float8,
          whatsapp_rate_limits.tokens
            + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - whatsapp_rate_limits.refilled_at)))
              * ${rate}::float8
        ) - 1,
        refilled_at = GREATEST(whatsapp_rate_limits.refilled_at, ${now}::timestamptz)
      WHERE LEAST(
          ${burst}::float8,
          whatsapp_rate_limits.tokens
            + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - whatsapp_rate_limits.refilled_at)))
              * ${rate}::float8
        ) >= 1
      RETURNING tokens
    `);
    if (granted.length > 0) return { allowed: true } as const;

    // Sem ficha: quanto falta para chegar a 1?
    const rows = await tx.$queryRaw<Array<{ available: number }>>(Prisma.sql`
      SELECT LEAST(
          ${burst}::float8,
          tokens + GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - refilled_at))) * ${rate}::float8
        ) AS available
      FROM whatsapp_rate_limits
      WHERE phone_number_id = ${phoneNumberId}
    `);
    const available = rows[0]?.available ?? 0;
    const retryAfterMs = Math.max(1, Math.ceil(((1 - available) / rate) * 1000));
    return { allowed: false, retryAfterMs } as const;
  });
}
