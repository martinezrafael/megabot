import { Prisma } from './generated/prisma/client';
import { withTenant } from './tenant-helper';

/**
 * Configuração do agente, versionada (T2.4).
 *
 * Regras que valem para TODAS as funções daqui:
 *  - sempre dentro de `withTenant` (RLS), com `tenant_id` explícito nos filtros;
 *  - a tabela é **append-only**: salvar insere uma versão nova, nunca atualiza nem apaga;
 *  - a versão ATIVA é a de maior `version` — não existe coluna "ativa" para desencontrar;
 *  - restaurar uma versão antiga insere uma CÓPIA dela como versão nova, com
 *    `restoredFromVersion` apontando para a origem. O histórico nunca é reescrito;
 *  - nada de conteúdo em log: o texto é dado do cliente. Só versão, contagens e ids.
 */

export type AgentTone = 'formal' | 'neutro' | 'amigavel' | 'descontraido';

export interface AgentToneOption {
  key: AgentTone;
  label: string;
  /** Como esse tom soa, em uma frase — é o que a tela mostra embaixo da opção. */
  hint: string;
}

/** Os tons que o banco aceita (CHECK em agent_configs.tone). */
export const AGENT_TONES: readonly AgentToneOption[] = [
  { key: 'formal', label: 'Formal', hint: 'Trata por "senhor/senhora" e evita gírias.' },
  { key: 'neutro', label: 'Neutro', hint: 'Direto e profissional, sem informalidade.' },
  { key: 'amigavel', label: 'Amigável', hint: 'Próximo e cordial, trata por "você".' },
  { key: 'descontraido', label: 'Descontraído', hint: 'Leve e informal, pode usar emoji.' },
] as const;

export type AgentToolStatus = 'disponivel' | 'em_breve';

export interface AgentToolOption {
  key: string;
  label: string;
  description: string;
  /**
   * `disponivel` = o agente realmente sabe fazer isso hoje.
   * `em_breve` = está no mapa, mas ainda não existe — e por isso NÃO pode ser habilitada: a
   * configuração não promete ao cliente um comportamento que o produto não tem.
   */
  status: AgentToolStatus;
}

/**
 * Catálogo de ferramentas. Fica no CÓDIGO (não no banco) de propósito: ligar uma ferramenta nova
 * é mexer aqui e na tela, sem migration. Quando a ferramenta passar a existir de verdade, troque
 * o `status` para `disponivel` — é a única mudança necessária para ela aparecer habilitável.
 */
export const AGENT_TOOLS: readonly AgentToolOption[] = [
  {
    key: 'base_conhecimento',
    label: 'Consultar a base de conhecimento',
    description:
      'Busca nos conteúdos que a empresa cadastrou e responde citando o que encontrou (T2.2/T2.3).',
    status: 'disponivel',
  },
  {
    key: 'escalar_humano',
    label: 'Encaminhar para uma pessoa',
    description: 'Passa a conversa para o atendimento humano quando não souber ou o cliente pedir.',
    status: 'em_breve',
  },
  {
    key: 'consultar_pedido',
    label: 'Consultar pedido',
    description: 'Busca a situação de um pedido no sistema da loja.',
    status: 'em_breve',
  },
  {
    key: 'agendar_horario',
    label: 'Agendar horário',
    description: 'Oferece horários livres e marca um atendimento na agenda.',
    status: 'em_breve',
  },
] as const;

export const agentTool = (key: string): AgentToolOption | undefined =>
  AGENT_TOOLS.find((tool) => tool.key === key);

export const MAX_AGENT_NAME = 80;
export const MAX_AGENT_GREETING = 1000;
export const MAX_AGENT_RULES = 30;
export const MAX_AGENT_RULE = 500;

/** O que um tenant que nunca salvou nada tem: configuração neutra e só a ferramenta que existe. */
export const DEFAULT_AGENT_CONFIG: AgentConfigInput = {
  name: 'Assistente',
  tone: 'amigavel',
  greeting: 'Olá! Sou o assistente virtual e estou aqui para ajudar. Como posso te atender hoje?',
  tools: ['base_conhecimento'],
  rules: [
    'Responda apenas com base nos conteúdos cadastrados pela empresa.',
    'Quando não souber a resposta, diga que não sabe e ofereça falar com uma pessoa.',
  ],
};

export interface AgentConfigInput {
  name: string;
  tone: AgentTone;
  greeting: string;
  tools: string[];
  rules: string[];
}

export interface AgentConfigRecord extends AgentConfigInput {
  id: string;
  tenantId: string;
  version: number;
  createdByUserId: string | null;
  /** Nome de quem salvou, para o histórico. Nulo se a conta foi apagada. */
  createdByName: string | null;
  restoredFromVersion: number | null;
  createdAt: Date;
}

export class AgentConfigVersionNotFoundError extends Error {
  constructor(version: number) {
    super(`A versão ${version} não existe nesta empresa.`);
    this.name = 'AgentConfigVersionNotFoundError';
  }
}

export class AgentConfigAlreadyActiveError extends Error {
  constructor(version: number) {
    super(`A versão ${version} já é a que está no ar.`);
    this.name = 'AgentConfigAlreadyActiveError';
  }
}

export class UnknownAgentToolError extends Error {
  constructor(key: string) {
    super(`A ferramenta "${key}" não existe.`);
    this.name = 'UnknownAgentToolError';
  }
}

export class AgentToolUnavailableError extends Error {
  constructor(tool: AgentToolOption) {
    super(`A ferramenta "${tool.label}" ainda não está disponível.`);
    this.name = 'AgentToolUnavailableError';
  }
}

export class AgentConfigInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigInvalidError';
  }
}

/** Erro de corrida: duas pessoas salvaram no mesmo instante e as duas pegaram a mesma versão. */
export class AgentConfigConflictError extends Error {
  constructor() {
    super('Alguém salvou a configuração ao mesmo tempo. Recarregue a tela e tente de novo.');
    this.name = 'AgentConfigConflictError';
  }
}

const SELECT = {
  id: true,
  tenantId: true,
  version: true,
  name: true,
  tone: true,
  greeting: true,
  tools: true,
  rules: true,
  createdByUserId: true,
  restoredFromVersion: true,
  createdAt: true,
  createdBy: { select: { name: true } },
} as const;

type Row = {
  id: string;
  tenantId: string;
  version: number;
  name: string;
  tone: string;
  greeting: string;
  tools: string[];
  rules: string[];
  createdByUserId: string | null;
  restoredFromVersion: number | null;
  createdAt: Date;
  createdBy: { name: string } | null;
};

const toRecord = (row: Row): AgentConfigRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  version: row.version,
  name: row.name,
  tone: row.tone as AgentTone,
  greeting: row.greeting,
  tools: row.tools,
  rules: row.rules,
  createdByUserId: row.createdByUserId,
  createdByName: row.createdBy?.name ?? null,
  restoredFromVersion: row.restoredFromVersion,
  createdAt: row.createdAt,
});

/**
 * Limpa e confere o que veio da tela. Aqui ficam as regras de DOMÍNIO (tom existente, ferramenta
 * existente e disponível, nada vazio); tamanho e formato do corpo HTTP são conferidos na API.
 */
export function normalizeAgentConfigInput(input: AgentConfigInput): AgentConfigInput {
  const name = input.name.trim();
  const greeting = input.greeting.trim();
  if (!name) throw new AgentConfigInvalidError('O nome do assistente não pode ficar vazio.');
  if (name.length > MAX_AGENT_NAME) {
    throw new AgentConfigInvalidError(`O nome passa de ${MAX_AGENT_NAME} caracteres.`);
  }
  if (!greeting) throw new AgentConfigInvalidError('A apresentação não pode ficar vazia.');
  if (greeting.length > MAX_AGENT_GREETING) {
    throw new AgentConfigInvalidError(`A apresentação passa de ${MAX_AGENT_GREETING} caracteres.`);
  }
  if (!AGENT_TONES.some((tone) => tone.key === input.tone)) {
    throw new AgentConfigInvalidError(`O tom "${input.tone}" não existe.`);
  }

  // Ferramentas: sem repetição, todas do catálogo e todas realmente disponíveis.
  const tools: string[] = [];
  for (const key of input.tools) {
    const found = agentTool(key.trim());
    if (!found) throw new UnknownAgentToolError(key.trim());
    if (found.status !== 'disponivel') throw new AgentToolUnavailableError(found);
    if (!tools.includes(found.key)) tools.push(found.key);
  }

  // Regras: linhas em branco somem (a tela permite campos vazios enquanto a pessoa digita).
  const rules = input.rules.map((rule) => rule.trim()).filter(Boolean);
  if (rules.length > MAX_AGENT_RULES) {
    throw new AgentConfigInvalidError(`São no máximo ${MAX_AGENT_RULES} regras.`);
  }
  const longest = rules.find((rule) => rule.length > MAX_AGENT_RULE);
  if (longest) {
    throw new AgentConfigInvalidError(`Uma das regras passa de ${MAX_AGENT_RULE} caracteres.`);
  }

  return { name, tone: input.tone, greeting, tools, rules };
}

/** A configuração no ar, ou `null` se este tenant nunca salvou nada. */
export async function getActiveAgentConfig(tenantId: string): Promise<AgentConfigRecord | null> {
  const row = await withTenant(tenantId, (tx) =>
    tx.agentConfig.findFirst({
      where: { tenantId },
      orderBy: { version: 'desc' },
      select: SELECT,
    }),
  );
  return row ? toRecord(row as Row) : null;
}

/**
 * A configuração no ar, com os padrões quando ainda não existe nenhuma versão salva.
 * `version: 0` é a marca de "isto é o padrão, ninguém salvou ainda".
 */
export async function getActiveAgentConfigOrDefault(tenantId: string): Promise<AgentConfigRecord> {
  const active = await getActiveAgentConfig(tenantId);
  if (active) return active;
  return {
    id: '',
    tenantId,
    version: 0,
    ...DEFAULT_AGENT_CONFIG,
    tools: [...DEFAULT_AGENT_CONFIG.tools],
    rules: [...DEFAULT_AGENT_CONFIG.rules],
    createdByUserId: null,
    createdByName: null,
    restoredFromVersion: null,
    createdAt: new Date(0),
  };
}

export async function getAgentConfigVersion(
  tenantId: string,
  version: number,
): Promise<AgentConfigRecord> {
  const row = await withTenant(tenantId, (tx) =>
    tx.agentConfig.findFirst({ where: { tenantId, version }, select: SELECT }),
  );
  if (!row) throw new AgentConfigVersionNotFoundError(version);
  return toRecord(row as Row);
}

/** Histórico, da versão mais nova para a mais antiga. */
export async function listAgentConfigVersions(
  tenantId: string,
  page: { limit?: number; offset?: number } = {},
): Promise<{ total: number; activeVersion: number; items: AgentConfigRecord[] }> {
  const limit = Math.min(Math.max(page.limit ?? 20, 1), 100);
  const offset = Math.max(page.offset ?? 0, 0);
  const { total, rows } = await withTenant(tenantId, async (tx) => {
    const [total, rows] = await Promise.all([
      tx.agentConfig.count({ where: { tenantId } }),
      tx.agentConfig.findMany({
        where: { tenantId },
        orderBy: { version: 'desc' },
        skip: offset,
        take: limit,
        select: SELECT,
      }),
    ]);
    return { total, rows };
  });
  const items = (rows as Row[]).map(toRecord);
  // A ativa é a de maior versão — e `total` é também o número da última, porque a tabela é
  // append-only e as versões não têm buracos.
  return { total, activeVersion: total, items };
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Insere uma versão nova.
 *
 * O número da versão sai de `MAX(version) + 1`, e isso é uma corrida: em READ COMMITTED, duas
 * transações simultâneas leem o MESMO máximo e tentam gravar o mesmo número. Por isso a transação
 * começa pegando um **lock de aviso por tenant** (`pg_advisory_xact_lock`), que serializa os
 * salvamentos de uma empresa — e só dela. Salvar configuração é alguém clicando em "Salvar": o
 * custo de esperar a vez é irrelevante perto de uma versão perdida.
 *
 * O índice único (tenant_id, version) continua ali como rede: se o lock falhar por algum motivo,
 * o banco recusa a duplicata e a gente tenta de novo em vez de gravar errado.
 */
async function insertVersion(
  tenantId: string,
  input: AgentConfigInput,
  options: { userId?: string | null; restoredFromVersion?: number | null } = {},
): Promise<AgentConfigRecord> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const row = await withTenant(tenantId, async (tx) => {
        // Liberado no commit/rollback da transação, sempre — não existe lock esquecido.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent_configs'), hashtext(${tenantId}))`;
        const last = await tx.agentConfig.aggregate({
          where: { tenantId },
          _max: { version: true },
        });
        const version = (last._max.version ?? 0) + 1;
        return tx.agentConfig.create({
          data: {
            tenantId,
            version,
            name: input.name,
            tone: input.tone,
            greeting: input.greeting,
            tools: input.tools,
            rules: input.rules,
            createdByUserId: options.userId ?? null,
            restoredFromVersion: options.restoredFromVersion ?? null,
          },
          select: SELECT,
        });
      });
      return toRecord(row as Row);
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 3) continue;
      if (isUniqueViolation(error)) throw new AgentConfigConflictError();
      throw error;
    }
  }
  throw new AgentConfigConflictError();
}

/** Salva uma configuração nova (sempre como versão nova). */
export async function saveAgentConfig(
  tenantId: string,
  input: AgentConfigInput,
  options: { userId?: string | null } = {},
): Promise<AgentConfigRecord> {
  return insertVersion(tenantId, normalizeAgentConfigInput(input), { userId: options.userId });
}

/**
 * Rollback: copia o conteúdo de uma versão antiga para uma versão NOVA.
 *
 * O conteúdo é copiado como está, sem passar pela validação de domínio de novo: o histórico é o
 * histórico. Se uma ferramenta tiver saído do catálogo depois, ela volta junto — e quem decide o
 * que fazer com isso é o agente, que ignora ferramenta desconhecida.
 */
export async function restoreAgentConfigVersion(
  tenantId: string,
  version: number,
  options: { userId?: string | null } = {},
): Promise<AgentConfigRecord> {
  const [active, target] = await Promise.all([
    getActiveAgentConfig(tenantId),
    getAgentConfigVersion(tenantId, version),
  ]);
  if (active && active.version === version) throw new AgentConfigAlreadyActiveError(version);
  return insertVersion(
    tenantId,
    {
      name: target.name,
      tone: target.tone,
      greeting: target.greeting,
      tools: [...target.tools],
      rules: [...target.rules],
    },
    { userId: options.userId, restoredFromVersion: version },
  );
}
