import { Prisma } from '../generated/prisma/client';
import { withTenant } from '../tenant-helper';

/**
 * Decisão "o agente (LLM) deve responder a esta mensagem?" (T1.5, ADR 0010 e 0011).
 *
 * A regra em si é uma função PURA (`decideAgentTrigger`): recebe os fatos e devolve a decisão e o
 * motivo. As consultas ao banco ficam à parte (`getTenantGate`, `getConversationQuotaPosition`),
 * assim a regra se testa sem banco e o motivo sempre aparece nos logs e métricas.
 */

export type AgentDecisionReason =
  | 'ok'
  /** Tenant suspenso: nada de LLM (e nada de custo). */
  | 'tenant_inactive'
  /** A janela de 24h já venceu (mensagem atrasada): o bot não poderia responder com texto livre. */
  | 'window_expired'
  /** Tipo de mensagem que o agente ainda não trata (imagem, áudio, reação...). */
  | 'unsupported_type'
  /** A conversa está além do limite mensal do tenant (ADR 0011, regra 5). */
  | 'quota_exceeded';

export interface AgentDecision {
  trigger: boolean;
  reason: AgentDecisionReason;
}

/** Tipos de mensagem recebida que o agente entende: o cliente escreveu ou tocou numa opção. */
export const AGENT_MESSAGE_TYPES: readonly string[] = ['text', 'interactive', 'button'];

export interface AgentDecisionInput {
  tenantStatus: string;
  messageType: string;
  /** Estado da janela de 24h NO MOMENTO da decisão. */
  windowOpen: boolean;
  /** Limite de conversas por mês do tenant; `null` = sem limite. */
  quotaLimit: number | null;
  /** Posição desta conversa entre as conversas do mês (1 = a primeira do mês). */
  quotaPosition: number;
}

/**
 * Ordem das checagens (a primeira que falhar é o motivo registrado):
 *   1. tenant ativo  2. janela aberta  3. tipo suportado  4. cota.
 *
 * Cota: a conversa só é atendida se a posição dela no mês for ≤ limite. Como a posição de uma
 * conversa não muda quando outras chegam depois, conversas JÁ abertas continuam sendo atendidas
 * depois que o limite é atingido; só as NOVAS são bloqueadas (ADR 0011, regra 5).
 */
export function decideAgentTrigger(input: AgentDecisionInput): AgentDecision {
  if (input.tenantStatus !== 'active') return { trigger: false, reason: 'tenant_inactive' };
  if (!input.windowOpen) return { trigger: false, reason: 'window_expired' };
  if (!AGENT_MESSAGE_TYPES.includes(input.messageType)) {
    return { trigger: false, reason: 'unsupported_type' };
  }
  if (input.quotaLimit !== null && input.quotaPosition > input.quotaLimit) {
    return { trigger: false, reason: 'quota_exceeded' };
  }
  return { trigger: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export interface TenantGate {
  status: string;
  conversationLimitPerMonth: number | null;
}

/** Status e limite do tenant. `null` se o tenant não existe (job de tenant apagado). */
export function getTenantGate(tenantId: string): Promise<TenantGate | null> {
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, conversationLimitPerMonth: true },
    });
    return tenant
      ? { status: tenant.status, conversationLimitPerMonth: tenant.conversationLimitPerMonth }
      : null;
  });
}

/** Fuso do período da cota (ADR 0011, regra 2). */
export const QUOTA_TIME_ZONE = 'America/Sao_Paulo';

/**
 * Posição da conversa entre as conversas abertas no MESMO mês (fuso de São Paulo): 1 = primeira.
 * A ordem é (início da janela, id), então é estável: reprocessar o job ou receber outra conversa
 * depois não muda a posição de quem já existe. Isso dispensa contador e trava, e o consumo do mês
 * continua recalculável (ADR 0011, regra 10).
 *
 * Observação: uma mensagem muito atrasada que abre uma conversa "no passado" pode empurrar a
 * posição de conversas posteriores do mesmo mês. É raro e só ocorre perto do limite.
 */
export async function getConversationQuotaPosition(
  tenantId: string,
  conversationId: string,
): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ position: number | null }>>(Prisma.sql`
      WITH me AS (
        SELECT window_started_at AS started_at, id
        FROM conversations
        WHERE tenant_id = ${tenantId}::uuid AND id = ${conversationId}::uuid
      ),
      period AS (
        SELECT
          me.started_at,
          me.id,
          date_trunc('month', me.started_at AT TIME ZONE ${QUOTA_TIME_ZONE}) AT TIME ZONE ${QUOTA_TIME_ZONE} AS period_start,
          (date_trunc('month', me.started_at AT TIME ZONE ${QUOTA_TIME_ZONE}) + interval '1 month') AT TIME ZONE ${QUOTA_TIME_ZONE} AS period_end
        FROM me
      )
      SELECT COUNT(c.id)::int AS position
      FROM period p
      LEFT JOIN conversations c
        ON c.tenant_id = ${tenantId}::uuid
       AND c.window_started_at >= p.period_start
       AND c.window_started_at < p.period_end
       AND (c.window_started_at, c.id) <= (p.started_at, p.id)
    `);
    // Conversa inexistente (ou de outro tenant): `me` fica vazia e o COUNT sem GROUP BY devolve 0.
    // 0 NUNCA pode passar como "posição": quem chama trata `null` como "não há conversa".
    const position = rows[0]?.position ?? 0;
    return position > 0 ? position : null;
  });
}
