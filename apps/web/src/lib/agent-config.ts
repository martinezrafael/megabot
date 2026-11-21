import type { components } from './api/schema';

/** Tipos gerados do contrato OpenAPI (apps/api/openapi.json). */
export type AgentConfig = components['schemas']['AgentConfigDto'];
export type AgentConfigOptions = components['schemas']['AgentConfigOptionsDto'];
export type AgentConfigVersionPage = components['schemas']['AgentConfigVersionPageDto'];
export type AgentToneOption = components['schemas']['AgentToneOptionDto'];
export type AgentToolOption = components['schemas']['AgentToolOptionDto'];

export interface AgentFetchOptions {
  apiUrl: string;
  cookie: string;
  forwardedFor?: string;
  requestId?: string;
  fetchImpl?: typeof fetch;
}

export type AgentResult<T> = { status: 'ok'; data: T } | { status: 'forbidden' | 'not_found' };

async function get<T>(path: string, o: AgentFetchOptions): Promise<AgentResult<T>> {
  const response = await (o.fetchImpl ?? fetch)(`${o.apiUrl}${path}`, {
    headers: {
      cookie: o.cookie,
      ...(o.forwardedFor ? { 'x-forwarded-for': o.forwardedFor } : {}),
      ...(o.requestId ? { 'x-request-id': o.requestId } : {}),
    },
    cache: 'no-store',
  });
  if (response.status === 401 || response.status === 403) return { status: 'forbidden' };
  if (response.status === 404) return { status: 'not_found' };
  if (!response.ok) throw new Error(`Falha ao consultar ${path}: ${response.status}`);
  return { status: 'ok', data: (await response.json()) as T };
}

export const fetchAgentConfig = (o: AgentFetchOptions) => get<AgentConfig>('/agent-config', o);

export const fetchAgentConfigOptions = (o: AgentFetchOptions) =>
  get<AgentConfigOptions>('/agent-config/options', o);

export const fetchAgentConfigVersions = (
  o: AgentFetchOptions,
  page: { limit?: number; offset?: number } = {},
) =>
  get<AgentConfigVersionPage>(
    `/agent-config/versions?limit=${page.limit ?? 20}&offset=${page.offset ?? 0}`,
    o,
  );

/** Rótulo do tom, para o histórico não mostrar a chave crua ("amigavel"). */
export const toneLabel = (tones: AgentToneOption[], key: string): string =>
  tones.find((tone) => tone.key === key)?.label ?? key;

/** Rótulo da ferramenta; cai na chave se ela saiu do catálogo depois de ter sido salva. */
export const toolLabel = (tools: AgentToolOption[], key: string): string =>
  tools.find((tool) => tool.key === key)?.label ?? key;

/** "Versão 3 · restaurada da 1" — o que o histórico mostra na primeira coluna. */
export function versionLabel(config: AgentConfig): string {
  return config.restoredFromVersion === null
    ? `Versão ${config.version}`
    : `Versão ${config.version} · restaurada da ${config.restoredFromVersion}`;
}
