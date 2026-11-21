import type { components } from './api/schema';

/** Tipos gerados do contrato OpenAPI (apps/api/openapi.json). */
export type KnowledgeSource = components['schemas']['KnowledgeSourceDto'];
export type KnowledgeChunk = components['schemas']['KnowledgeChunkDto'];
export type KnowledgeChunkPage = components['schemas']['KnowledgeChunkPageDto'];
export type KnowledgeLimits = components['schemas']['KnowledgeLimitsDto'];

export interface KnowledgeFetchOptions {
  apiUrl: string;
  cookie: string;
  forwardedFor?: string;
  requestId?: string;
  fetchImpl?: typeof fetch;
}

export type KnowledgeResult<T> = { status: 'ok'; data: T } | { status: 'forbidden' | 'not_found' };

async function get<T>(path: string, o: KnowledgeFetchOptions): Promise<KnowledgeResult<T>> {
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

export const fetchKnowledgeSources = (o: KnowledgeFetchOptions) =>
  get<KnowledgeSource[]>('/knowledge/sources', o);

export const fetchKnowledgeSource = (o: KnowledgeFetchOptions, id: string) =>
  get<KnowledgeSource>(`/knowledge/sources/${encodeURIComponent(id)}`, o);

export const fetchKnowledgeChunks = (
  o: KnowledgeFetchOptions,
  id: string,
  page: { limit?: number; offset?: number } = {},
) =>
  get<KnowledgeChunkPage>(
    `/knowledge/sources/${encodeURIComponent(id)}/chunks?limit=${page.limit ?? 50}&offset=${page.offset ?? 0}`,
    o,
  );

export const fetchKnowledgeLimits = (o: KnowledgeFetchOptions) =>
  get<KnowledgeLimits>('/knowledge/limits', o);
