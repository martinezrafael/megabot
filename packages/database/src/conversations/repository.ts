import { Prisma } from '../generated/prisma/client';
import { withTenant } from '../tenant-helper';
import { CONVERSATION_METRIC, type ConversationObservability } from './observability';
import {
  WindowClosedError,
  canSendFreeform,
  conversationState,
  planInboundWindow,
  remainingMs,
  statusesThatCanAdvanceTo,
  type ConversationState,
  type ExistingConversation,
  type OutboundStatus,
} from './window';

/**
 * Repositórios de contatos, conversas (janelas de 24h) e mensagens (T1.4).
 *
 * Regras que valem para TODAS as funções:
 *  - sempre dentro de `withTenant` (RLS) e com `tenantId` explícito nos filtros;
 *  - "agora" é parâmetro (`options.now`): testes e reprocessamentos não dependem do relógio;
 *  - nada de texto de mensagem, nome ou número completo em log; só ids e `tenant_id`.
 */

export interface RepositoryOptions extends ConversationObservability {
  /** Relógio injetável (padrão: agora). */
  now?: Date;
}

const WA_ID = /^\d{7,15}$/;
const MAX_ERROR_MESSAGE = 500;

function assertWaId(waId: string): void {
  if (!WA_ID.test(waId)) {
    throw new Error('waId inválido: use só dígitos (E.164 sem "+", 7 a 15 dígitos).');
  }
}

function count(
  options: RepositoryOptions,
  name: string,
  tenantId: string,
  labels: Record<string, string> = {},
  value = 1,
): void {
  options.metrics?.increment(name, { tenant_id: tenantId, ...labels }, value);
}

// ---------------------------------------------------------------------------
// Contatos
// ---------------------------------------------------------------------------

export interface ContactRecord {
  id: string;
  tenantId: string;
  waId: string;
  profileName: string | null;
}

interface ContactRow {
  id: string;
  tenant_id: string;
  wa_id: string;
  profile_name: string | null;
}

const toContact = (r: ContactRow): ContactRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  waId: r.wa_id,
  profileName: r.profile_name,
});

/**
 * Cria o contato ou devolve o existente (atômico: dois webhooks simultâneos do mesmo número
 * não duplicam). O nome do perfil só é atualizado quando vem preenchido. A linha fica TRAVADA
 * até o fim da transação, o que serializa mensagens do mesmo contato.
 */
async function upsertContactTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  waId: string,
  profileName: string | null | undefined,
): Promise<ContactRecord> {
  assertWaId(waId);
  const rows = await tx.$queryRaw<ContactRow[]>`
    INSERT INTO contacts (tenant_id, wa_id, profile_name, updated_at)
    VALUES (${tenantId}::uuid, ${waId}, ${profileName ?? null}, now())
    ON CONFLICT (tenant_id, wa_id)
    DO UPDATE SET profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name),
                  updated_at = now()
    RETURNING id, tenant_id, wa_id, profile_name`;
  return toContact(rows[0]!);
}

export function upsertContact(
  tenantId: string,
  input: { waId: string; profileName?: string | null },
): Promise<ContactRecord> {
  return withTenant(tenantId, (tx) => upsertContactTx(tx, tenantId, input.waId, input.profileName));
}

export function findContactByWaId(tenantId: string, waId: string): Promise<ContactRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.contact.findUnique({
      where: { tenantId_waId: { tenantId, waId } },
      select: { id: true, tenantId: true, waId: true, profileName: true },
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Janela / conversa
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  status: 'open' | 'expired';
  window_started_at: Date;
  window_expires_at: Date;
  last_inbound_at: Date;
}

const toExisting = (r: ConversationRow): ExistingConversation => ({
  id: r.id,
  status: r.status,
  windowStartedAt: r.window_started_at,
  windowExpiresAt: r.window_expires_at,
  lastInboundAt: r.last_inbound_at,
});

const CONVERSATION_COLUMNS = Prisma.sql`id, status, window_started_at, window_expires_at, last_inbound_at`;

async function findOpenConversation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
): Promise<ExistingConversation | null> {
  const rows = await tx.$queryRaw<ConversationRow[]>`
    SELECT ${CONVERSATION_COLUMNS} FROM conversations
     WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid AND status = 'open'
     FOR UPDATE`;
  return rows[0] ? toExisting(rows[0]) : null;
}

async function findCoveringExpired(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
  at: Date,
): Promise<ExistingConversation | null> {
  const rows = await tx.$queryRaw<ConversationRow[]>`
    SELECT ${CONVERSATION_COLUMNS} FROM conversations
     WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid
       AND status = 'expired' AND window_started_at <= ${at} AND ${at} < window_expires_at
     ORDER BY window_started_at DESC LIMIT 1`;
  return rows[0] ? toExisting(rows[0]) : null;
}

export interface WindowInfo {
  state: ConversationState;
  conversationId: string | null;
  windowStartedAt: Date | null;
  windowExpiresAt: Date | null;
  remainingSeconds: number;
  /** Pode enviar mensagem livre agora? (ADR 0010, decisões 4 e 5) */
  canSendFreeform: boolean;
}

const CLOSED_WINDOW: WindowInfo = {
  state: 'expired',
  conversationId: null,
  windowStartedAt: null,
  windowExpiresAt: null,
  remainingSeconds: 0,
  canSendFreeform: false,
};

function windowInfo(conv: ExistingConversation | null, now: Date): WindowInfo {
  if (!conv) return CLOSED_WINDOW;
  const snapshot = { status: conv.status, windowExpiresAt: conv.windowExpiresAt };
  return {
    state: conversationState(snapshot, now),
    conversationId: conv.id,
    windowStartedAt: conv.windowStartedAt,
    windowExpiresAt: conv.windowExpiresAt,
    remainingSeconds: Math.floor(remainingMs(snapshot, now) / 1000),
    canSendFreeform: canSendFreeform(snapshot, now),
  };
}

/** Situação da janela de um contato AGORA (estado efetivo: considera o relógio, não só o banco). */
export function getContactWindow(
  tenantId: string,
  contactId: string,
  options: Pick<RepositoryOptions, 'now'> = {},
): Promise<WindowInfo> {
  const now = options.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<ConversationRow[]>`
      SELECT ${CONVERSATION_COLUMNS} FROM conversations
       WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid AND status = 'open'`;
    return windowInfo(rows[0] ? toExisting(rows[0]) : null, now);
  });
}

// ---------------------------------------------------------------------------
// Mensagem recebida
// ---------------------------------------------------------------------------

export interface InboundMessageInput {
  /** Número do contato (só dígitos). */
  waId: string;
  profileName?: string | null;
  wamid: string;
  /** text, image, audio, video, document, sticker, location, contacts, button, interactive, reaction... */
  type: string;
  body?: string | null;
  /** Dados do tipo (mídia, localização...). Sem o texto, que vai em `body`. */
  content?: Prisma.InputJsonValue | null;
  /** Hora da mensagem segundo a Meta (NUNCA a do cliente). */
  sentAt: Date;
}

export type WindowEffect =
  | 'opened' // abriu uma janela nova (conta cota)
  | 'renewed' // prazo estendido
  | 'unchanged' // mensagem dentro da janela sem estender (ex.: chegou fora de ordem)
  | 'late_attached' // mensagem atrasada guardada numa janela já expirada
  | 'late_expired' // mensagem antiga demais: janela criada já expirada
  | 'duplicate'; // wamid já registrado: nada foi alterado

export interface InboundMessageResult {
  contactId: string;
  conversationId: string;
  messageId: string;
  duplicate: boolean;
  window: WindowEffect;
  windowExpiresAt: Date;
}

/**
 * Registra uma mensagem RECEBIDA e aplica a regra da janela, tudo numa transação:
 *  - wamid repetido (reentrega da Meta) → devolve o registro existente, SEM abrir nem renovar nada;
 *  - senão: abre ou renova a janela conforme `planInboundWindow` (ADR 0010) e grava a mensagem.
 * Concorrência: a linha do contato fica travada, então mensagens simultâneas do mesmo contato
 * entram uma por vez e o índice parcial nunca vê duas janelas abertas.
 */
export function recordInboundMessage(
  tenantId: string,
  input: InboundMessageInput,
  options: RepositoryOptions = {},
): Promise<InboundMessageResult> {
  const now = options.now ?? new Date();

  return withTenant(tenantId, async (tx) => {
    const contact = await upsertContactTx(tx, tenantId, input.waId, input.profileName);

    const existing = await tx.message.findUnique({
      where: { tenantId_wamid: { tenantId, wamid: input.wamid } },
      select: { id: true, conversationId: true },
    });
    if (existing) {
      const conv = existing.conversationId
        ? await tx.conversation.findUnique({
            where: { tenantId_id: { tenantId, id: existing.conversationId } },
            select: { windowExpiresAt: true },
          })
        : null;
      count(options, CONVERSATION_METRIC.messages, tenantId, {
        direction: 'inbound',
        outcome: 'duplicate',
      });
      options.logger?.info(
        { event: 'conversation.message_duplicate', tenant_id: tenantId, contact_id: contact.id },
        'Mensagem repetida ignorada',
      );
      return {
        contactId: contact.id,
        conversationId: existing.conversationId ?? '',
        messageId: existing.id,
        duplicate: true,
        window: 'duplicate' as const,
        windowExpiresAt: conv?.windowExpiresAt ?? input.sentAt,
      };
    }

    const open = await findOpenConversation(tx, tenantId, contact.id);
    const covering = await findCoveringExpired(tx, tenantId, contact.id, input.sentAt);
    const plan = planInboundWindow({ at: input.sentAt, now, open, coveringExpired: covering });

    let conversationId: string;
    let windowExpiresAt: Date;
    let effect: WindowEffect;

    switch (plan.action) {
      case 'renew': {
        await tx.conversation.update({
          where: { tenantId_id: { tenantId, id: plan.target.id } },
          data: {
            windowStartedAt: plan.next.windowStartedAt,
            windowExpiresAt: plan.next.windowExpiresAt,
            lastInboundAt: plan.next.lastInboundAt,
          },
        });
        conversationId = plan.target.id;
        windowExpiresAt = plan.next.windowExpiresAt;
        effect = plan.extended ? 'renewed' : 'unchanged';
        break;
      }
      case 'attach_expired': {
        conversationId = plan.target.id;
        windowExpiresAt = plan.target.windowExpiresAt;
        effect = 'late_attached';
        break;
      }
      case 'open':
      case 'open_expired': {
        if (plan.action === 'open' && plan.expireOpenId) {
          // A janela anterior venceu antes desta mensagem: encerra-a ANTES de abrir a nova
          // (o índice parcial só admite uma aberta).
          await expireConversationTx(tx, tenantId, plan.expireOpenId, open!.windowExpiresAt);
        }
        const created = await tx.conversation.create({
          data: {
            tenantId,
            contactId: contact.id,
            status: plan.next.status,
            windowStartedAt: plan.next.windowStartedAt,
            windowExpiresAt: plan.next.windowExpiresAt,
            lastInboundAt: plan.next.lastInboundAt,
            expiredAt: plan.next.status === 'expired' ? plan.next.windowExpiresAt : null,
          },
          select: { id: true },
        });
        conversationId = created.id;
        windowExpiresAt = plan.next.windowExpiresAt;
        effect = plan.action === 'open' ? 'opened' : 'late_expired';
        break;
      }
    }

    const message = await tx.message.create({
      data: {
        tenantId,
        contactId: contact.id,
        conversationId,
        direction: 'inbound',
        sender: 'contact',
        type: input.type,
        body: input.body ?? null,
        content: input.content ?? Prisma.DbNull,
        wamid: input.wamid,
        status: 'received',
        sentAt: input.sentAt,
      },
      select: { id: true },
    });

    count(options, CONVERSATION_METRIC.messages, tenantId, {
      direction: 'inbound',
      outcome: 'created',
    });
    if (effect === 'opened') count(options, CONVERSATION_METRIC.windowOpened, tenantId);
    if (effect === 'renewed') count(options, CONVERSATION_METRIC.windowRenewed, tenantId);
    options.logger?.info(
      {
        event: `conversation.window_${effect}`,
        tenant_id: tenantId,
        contact_id: contact.id,
        conversation_id: conversationId,
        message_id: message.id,
        window_expires_at: windowExpiresAt.toISOString(),
      },
      'Mensagem recebida registrada',
    );

    return {
      contactId: contact.id,
      conversationId,
      messageId: message.id,
      duplicate: false,
      window: effect,
      windowExpiresAt,
    };
  });
}

async function expireConversationTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  conversationId: string,
  expiredAt: Date,
): Promise<void> {
  await tx.conversation.update({
    where: { tenantId_id: { tenantId, id: conversationId } },
    data: { status: 'expired', expiredAt },
  });
}

/**
 * Varredura: marca como `expired` as conversas abertas cujo prazo já passou. Seguro repetir.
 * O worker chama por tenant (RLS). Retorna quantas foram expiradas.
 */
export function expireDueConversations(
  tenantId: string,
  options: RepositoryOptions = {},
): Promise<number> {
  const now = options.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE conversations
         SET status = 'expired', expired_at = window_expires_at, updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND status = 'open' AND window_expires_at <= ${now}`;
    if (updated > 0) {
      count(options, CONVERSATION_METRIC.windowExpired, tenantId, {}, updated);
      options.logger?.info(
        { event: 'conversation.windows_expired', tenant_id: tenantId, count: updated },
        'Janelas expiradas',
      );
    }
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Mensagem enviada
// ---------------------------------------------------------------------------

export interface OutboundMessageInput {
  contactId: string;
  sender: 'bot' | 'agent';
  type: string;
  body?: string | null;
  content?: Prisma.InputJsonValue | null;
  /**
   * `free` (padrão): texto/mídia livre, SÓ com janela ativa (senão `WindowClosedError`).
   * `template`: permitido a qualquer momento (é o que a Meta aceita fora da janela).
   */
  kind?: 'free' | 'template';
}

export interface OutboundMessageRecord {
  id: string;
  contactId: string;
  conversationId: string | null;
  status: OutboundStatus;
}

/**
 * Cria a mensagem a ENVIAR (status `queued`, ainda sem wamid), verificando a janela NO MOMENTO
 * (ADR 0010, decisão 6: o worker chama isto logo antes de enviar, não ao enfileirar).
 * Mensagem enviada NUNCA renova a janela (decisão 3).
 */
export function prepareOutboundMessage(
  tenantId: string,
  input: OutboundMessageInput,
  options: RepositoryOptions = {},
): Promise<OutboundMessageRecord> {
  const now = options.now ?? new Date();
  const kind = input.kind ?? 'free';

  return withTenant(tenantId, async (tx) => {
    const contact = await tx.contact.findUnique({
      where: { tenantId_id: { tenantId, id: input.contactId } },
      select: { id: true },
    });
    if (!contact) throw new Error('Contato não encontrado neste tenant.');

    const rows = await tx.$queryRaw<ConversationRow[]>`
      SELECT ${CONVERSATION_COLUMNS} FROM conversations
       WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${input.contactId}::uuid AND status = 'open'`;
    const open = rows[0] ? toExisting(rows[0]) : null;
    const active =
      open && canSendFreeform({ status: open.status, windowExpiresAt: open.windowExpiresAt }, now)
        ? open
        : null;

    if (kind === 'free' && !active) {
      count(options, CONVERSATION_METRIC.outboundBlocked, tenantId, { reason: 'window_closed' });
      options.logger?.warn(
        {
          event: 'conversation.outbound_blocked',
          tenant_id: tenantId,
          contact_id: input.contactId,
          reason: 'window_closed',
        },
        'Envio livre bloqueado: janela de 24h fechada',
      );
      throw new WindowClosedError(input.contactId);
    }

    const message = await tx.message.create({
      data: {
        tenantId,
        contactId: input.contactId,
        conversationId: active?.id ?? null,
        direction: 'outbound',
        sender: input.sender,
        type: input.type,
        body: input.body ?? null,
        content: input.content ?? Prisma.DbNull,
        status: 'queued',
        sentAt: now,
      },
      select: { id: true, contactId: true, conversationId: true },
    });
    count(options, CONVERSATION_METRIC.messages, tenantId, {
      direction: 'outbound',
      outcome: 'created',
    });
    return { ...message, status: 'queued' as const };
  });
}

/** A Meta aceitou o envio: guarda o wamid. Se `sent`/`delivered` já chegaram antes (fora de ordem), não regride. */
export function markOutboundSent(
  tenantId: string,
  messageId: string,
  input: { wamid: string; at?: Date },
  options: RepositoryOptions = {},
): Promise<void> {
  const at = input.at ?? options.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    // O wamid sempre é gravado; o status só avança se ainda estiver `queued`.
    await tx.message.updateMany({
      where: { tenantId, id: messageId, direction: 'outbound', wamid: null },
      data: { wamid: input.wamid, sentAt: at },
    });
    await tx.message.updateMany({
      where: { tenantId, id: messageId, status: 'queued' },
      data: { status: 'sent' },
    });
  });
}

/** Falha de envio (antes de a Meta devolver wamid). */
export function markOutboundFailed(
  tenantId: string,
  messageId: string,
  input: { errorCode?: string; errorMessage?: string },
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.message.updateMany({
      where: { tenantId, id: messageId, direction: 'outbound', status: { in: ['queued', 'sent'] } },
      data: {
        status: 'failed',
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage?.slice(0, MAX_ERROR_MESSAGE) ?? null,
      },
    });
    return result.count > 0;
  });
}

export type StatusUpdateOutcome = 'updated' | 'ignored' | 'not_found';

/**
 * Aplica um status de entrega vindo do webhook (`sent`, `delivered`, `read`, `failed`).
 * O status só avança (ver `canAdvanceStatus`): evento repetido ou fora de ordem é `ignored`.
 * `not_found` = ainda não temos a mensagem com esse wamid (o webhook chegou antes de gravarmos o
 * wamid): quem chamou deve tentar de novo mais tarde (retry da fila).
 */
export function applyStatusUpdate(
  tenantId: string,
  input: {
    wamid: string;
    status: Exclude<OutboundStatus, 'queued'>;
    /** Hora do evento segundo a Meta. */
    at: Date;
    errorCode?: string;
    errorMessage?: string;
  },
  options: RepositoryOptions = {},
): Promise<StatusUpdateOutcome> {
  return withTenant(tenantId, async (tx) => {
    const target = await tx.message.findUnique({
      where: { tenantId_wamid: { tenantId, wamid: input.wamid } },
      select: { id: true, direction: true },
    });

    let outcome: StatusUpdateOutcome;
    if (!target || target.direction !== 'outbound') {
      outcome = 'not_found';
    } else {
      const result = await tx.message.updateMany({
        where: {
          tenantId,
          id: target.id,
          status: { in: [...statusesThatCanAdvanceTo(input.status)] },
        },
        data: {
          status: input.status,
          ...(input.status === 'delivered' ? { deliveredAt: input.at } : {}),
          ...(input.status === 'read' ? { readAt: input.at } : {}),
          ...(input.status === 'failed'
            ? {
                errorCode: input.errorCode ?? null,
                errorMessage: input.errorMessage?.slice(0, MAX_ERROR_MESSAGE) ?? null,
              }
            : {}),
        },
      });
      outcome = result.count > 0 ? 'updated' : 'ignored';
    }

    count(options, CONVERSATION_METRIC.statusUpdates, tenantId, { status: input.status, outcome });
    options.logger?.info(
      {
        event: 'conversation.status_update',
        tenant_id: tenantId,
        message_id: target?.id,
        status: input.status,
        outcome,
      },
      'Status de mensagem processado',
    );
    return outcome;
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export interface MessageRecord {
  id: string;
  conversationId: string | null;
  contactId: string;
  direction: string;
  sender: string;
  type: string;
  body: string | null;
  wamid: string | null;
  status: string;
  sentAt: Date;
}

const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  contactId: true,
  direction: true,
  sender: true,
  type: true,
  body: true,
  wamid: true,
  status: true,
  sentAt: true,
} as const;

export function findMessageByWamid(tenantId: string, wamid: string): Promise<MessageRecord | null> {
  return withTenant(tenantId, (tx) =>
    tx.message.findUnique({
      where: { tenantId_wamid: { tenantId, wamid } },
      select: MESSAGE_SELECT,
    }),
  );
}

/** Mensagens de uma conversa, da mais antiga para a mais nova (usa o índice tenant+conversa+data). */
export function listConversationMessages(
  tenantId: string,
  conversationId: string,
  options: { limit?: number } = {},
): Promise<MessageRecord[]> {
  const take = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  return withTenant(tenantId, (tx) =>
    tx.message.findMany({
      where: { tenantId, conversationId },
      orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }],
      take,
      select: MESSAGE_SELECT,
    }),
  );
}

export interface ConversationRecord {
  id: string;
  contactId: string;
  status: string;
  windowStartedAt: Date;
  windowExpiresAt: Date;
  lastInboundAt: Date;
}

/** Histórico de conversas (janelas) de um contato, da mais recente para a mais antiga. */
export function listContactConversations(
  tenantId: string,
  contactId: string,
  options: { limit?: number } = {},
): Promise<ConversationRecord[]> {
  const take = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
  return withTenant(tenantId, (tx) =>
    tx.conversation.findMany({
      where: { tenantId, contactId },
      orderBy: { windowStartedAt: 'desc' },
      take,
      select: {
        id: true,
        contactId: true,
        status: true,
        windowStartedAt: true,
        windowExpiresAt: true,
        lastInboundAt: true,
      },
    }),
  );
}
