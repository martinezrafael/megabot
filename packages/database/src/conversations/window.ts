/**
 * Regras da janela de 24h (ADR 0010) como funções PURAS: sem banco, sem relógio global.
 * Todo "agora" é passado como argumento, então os testes cobrem o limite exato de 24h sem esperar.
 *
 * Unidade: uma CONVERSA = uma janela de atendimento de um contato (ADR 0011).
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Faltando isto (ou menos) para expirar, a conversa fica "expiring" (a UI pode avisar o atendente). */
export const EXPIRING_SOON_MS = 60 * 60 * 1000;

/** Estado guardado no banco. */
export type StoredConversationStatus = 'open' | 'expired';

/** Estado efetivo, calculado com o relógio. É ele que as regras de envio usam. */
export type ConversationState = 'active' | 'expiring' | 'expired';

export interface WindowSnapshot {
  status: StoredConversationStatus;
  windowExpiresAt: Date;
}

/** A janela vai até a última mensagem RECEBIDA + 24h (deslizante). */
export function computeWindowExpiry(lastInboundAt: Date): Date {
  return new Date(lastInboundAt.getTime() + WINDOW_MS);
}

/**
 * Janela aberta = `agora` ANTES do vencimento. No instante exato do vencimento ela JÁ está fechada
 * (24h cravadas depois da mensagem não vale mais).
 */
export function isWindowOpen(windowExpiresAt: Date, now: Date): boolean {
  return now.getTime() < windowExpiresAt.getTime();
}

/** Estado efetivo. Uma conversa "open" no banco mas vencida (varredura ainda não passou) é `expired`. */
export function conversationState(window: WindowSnapshot, now: Date): ConversationState {
  if (window.status !== 'open' || !isWindowOpen(window.windowExpiresAt, now)) return 'expired';
  const remaining = window.windowExpiresAt.getTime() - now.getTime();
  return remaining <= EXPIRING_SOON_MS ? 'expiring' : 'active';
}

/** Milissegundos restantes (0 se já expirou). */
export function remainingMs(window: WindowSnapshot, now: Date): number {
  if (conversationState(window, now) === 'expired') return 0;
  return window.windowExpiresAt.getTime() - now.getTime();
}

/** Mensagem LIVRE (texto, mídia...) só dentro da janela. Template é outra regra (ver repositório). */
export function canSendFreeform(window: WindowSnapshot | null | undefined, now: Date): boolean {
  return window != null && conversationState(window, now) !== 'expired';
}

/** Erro de domínio: tentativa de enviar mensagem livre sem janela ativa (ADR 0010, decisão 5). */
export class WindowClosedError extends Error {
  /** Código estável para logs/métricas/respostas (`janela_expirada` no ADR 0010). */
  readonly code = 'window_expired';
  /** Repetir não adianta: só um template ou uma nova mensagem do cliente muda isso. */
  readonly retryable = false;
  /** Mesma categoria do @megabot/whatsapp para a Meta 131047, então o worker trata igual. */
  readonly category = 'window_expired';

  constructor(public readonly contactId: string) {
    super('Janela de 24h fechada: só é possível enviar template aprovado.');
    this.name = 'WindowClosedError';
  }
}

// ---------------------------------------------------------------------------
// O que fazer quando chega uma mensagem do contato
// ---------------------------------------------------------------------------

export interface PlannedWindow {
  status: StoredConversationStatus;
  windowStartedAt: Date;
  windowExpiresAt: Date;
  lastInboundAt: Date;
}

export interface ExistingConversation extends PlannedWindow {
  id: string;
}

export type InboundWindowPlan =
  /** Há janela aberta e a mensagem cai nela (ou antes dela): atualiza o prazo. */
  | { action: 'renew'; target: ExistingConversation; next: PlannedWindow; extended: boolean }
  /** Não há janela aberta (ou ela venceu antes da mensagem): abre uma nova. */
  | { action: 'open'; expireOpenId?: string; next: PlannedWindow }
  /** Mensagem atrasada de uma janela que já acabou: guarda lá, sem reabrir nem renovar. */
  | { action: 'attach_expired'; target: ExistingConversation }
  /** Mensagem tão antiga que a janela dela já passou e não existe registro: cria JÁ expirada (não conta cota). */
  | { action: 'open_expired'; next: PlannedWindow };

export interface PlanInboundInput {
  /** Hora da mensagem segundo a Meta (nunca a do cliente). */
  at: Date;
  now: Date;
  /** A conversa `open` do contato (no máximo uma, garantido por índice parcial). */
  open: ExistingConversation | null;
  /** Conversa já expirada cuja janela cobre `at` (início <= at < vencimento), se houver. */
  coveringExpired: ExistingConversation | null;
}

/**
 * Decide o que a mensagem recebida faz com as janelas. É o coração da regra (ADR 0010, decisões 2, 3 e 7):
 *
 *  0. Uma janela JÁ EXPIRADA cobre o instante da mensagem (mensagem atrasada) → só ANEXA a ela.
 *  1. Há janela aberta e a mensagem é anterior ao vencimento dela → RENOVA: o vencimento vira
 *     max(atual, mensagem + 24h) e o início recua se a mensagem for mais antiga (chegada fora de ordem).
 *  2. Há janela aberta, mas a mensagem é de DEPOIS do vencimento → a antiga expira e ABRE uma nova.
 *  3. Não há nada: ABRE uma janela em `at`. Se `at + 24h` já passou (mensagem muito atrasada), nasce expirada.
 *
 * Reentrega do mesmo wamid nunca chega aqui (o repositório a descarta antes: decisão 7).
 */
export function planInboundWindow(input: PlanInboundInput): InboundWindowPlan {
  const { at, now, open, coveringExpired } = input;
  const atMs = at.getTime();

  // Mensagem atrasada de uma janela que JÁ ACABOU (e que um registro cobre): fica lá. Vem antes da
  // renovação para ela não puxar para a janela atual uma mensagem que pertence a uma anterior.
  if (coveringExpired) {
    return { action: 'attach_expired', target: coveringExpired };
  }

  if (open && atMs < open.windowExpiresAt.getTime()) {
    const proposed = computeWindowExpiry(at);
    const expires = proposed > open.windowExpiresAt ? proposed : open.windowExpiresAt;
    return {
      action: 'renew',
      target: open,
      extended: expires.getTime() > open.windowExpiresAt.getTime(),
      next: {
        status: 'open',
        windowStartedAt: at < open.windowStartedAt ? at : open.windowStartedAt,
        windowExpiresAt: expires,
        lastInboundAt: at > open.lastInboundAt ? at : open.lastInboundAt,
      },
    };
  }

  const expiresAt = computeWindowExpiry(at);
  const next: PlannedWindow = {
    status: isWindowOpen(expiresAt, now) ? 'open' : 'expired',
    windowStartedAt: at,
    windowExpiresAt: expiresAt,
    lastInboundAt: at,
  };
  if (next.status === 'expired') return { action: 'open_expired', next };
  return open ? { action: 'open', expireOpenId: open.id, next } : { action: 'open', next };
}

// ---------------------------------------------------------------------------
// Status das mensagens enviadas (a Meta pode mandar fora de ordem)
// ---------------------------------------------------------------------------

export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type MessageStatus = OutboundStatus | 'received';

/**
 * De quais status atuais cada novo status pode "avançar". O status só anda para frente:
 * "delivered" que chega depois de "read" é ignorado; "failed" não desfaz "delivered"/"read".
 */
const ALLOWED_FROM: Record<OutboundStatus, readonly OutboundStatus[]> = {
  queued: [],
  sent: ['queued'],
  delivered: ['queued', 'sent'],
  read: ['queued', 'sent', 'delivered'],
  failed: ['queued', 'sent'],
};

export function statusesThatCanAdvanceTo(next: OutboundStatus): readonly OutboundStatus[] {
  return ALLOWED_FROM[next];
}

export function canAdvanceStatus(current: MessageStatus, next: OutboundStatus): boolean {
  return (ALLOWED_FROM[next] as readonly MessageStatus[]).includes(current);
}
