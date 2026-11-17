import type { components } from './api/schema';

/** Tipos gerados do contrato OpenAPI (apps/api/openapi.json). */
export type QueuesSnapshot = components['schemas']['QueuesSnapshotDto'];
export type QueueOverview = components['schemas']['QueueOverviewDto'];
export type JobSummary = components['schemas']['JobSummaryDto'];

export interface QueuesFetchOptions {
  apiUrl: string;
  cookie: string;
  forwardedFor?: string;
  requestId?: string;
  fetchImpl?: typeof fetch;
}

export type QueuesResult<T> = { status: 'ok'; data: T } | { status: 'forbidden' | 'not_found' };

async function get<T>(path: string, o: QueuesFetchOptions): Promise<QueuesResult<T>> {
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

export const fetchQueues = (o: QueuesFetchOptions) => get<QueuesSnapshot>('/admin/queues', o);

export const fetchQueueJobs = (o: QueuesFetchOptions, queue: string, limit = 25) =>
  get<JobSummary[]>(`/admin/queues/${encodeURIComponent(queue)}/jobs?limit=${limit}`, o);
