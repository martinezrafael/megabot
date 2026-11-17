import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { JobsTable, QueuesTable } from '@/components/queues-table';
import { parseWebEnv } from '@/env';
import { fetchQueueJobs, fetchQueues, type QueuesFetchOptions } from '@/lib/queues';
import { formatDateTime } from '@/lib/queues-format';
import { getMe } from '@/lib/server-session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Filas · Megabot' };

/**
 * Tela de filas (somente plataforma). Lê o resumo e os jobs pela API, que lê as tabelas do pg-boss.
 * Quem não é administrador da plataforma recebe 404 (a tela nem "existe" para essa pessoa).
 */
export default async function QueuesPage({
  searchParams,
}: {
  searchParams: Promise<{ queue?: string | string[] }>;
}) {
  const me = await getMe();
  if (!me?.platformAdmin) notFound();

  const [cookieStore, requestHeaders, params] = await Promise.all([
    cookies(),
    headers(),
    searchParams,
  ]);
  const options: QueuesFetchOptions = {
    apiUrl: parseWebEnv(process.env).serverApiUrl,
    cookie: cookieStore.toString(),
    forwardedFor: requestHeaders.get('x-forwarded-for') ?? undefined,
    requestId: requestHeaders.get('x-request-id') ?? undefined,
  };

  const overview = await fetchQueues(options);
  if (overview.status !== 'ok') notFound();
  const snapshot = overview.data;

  // Fila escolhida: a do link, ou a primeira DLQ com jobs (o que mais precisa de atenção).
  const requested = typeof params.queue === 'string' ? params.queue : undefined;
  const selected =
    snapshot.queues.find((q) => q.name === requested)?.name ??
    snapshot.queues.find((q) => q.isDeadLetter && q.counts.created > 0)?.name;
  const jobs = selected ? await fetchQueueJobs(options, selected) : undefined;

  return (
    <section>
      <h1>Filas</h1>
      <p className="subtitle">
        Estado das filas de tarefas (pg-boss). Atualizado em {formatDateTime(snapshot.generatedAt)}.
      </p>
      <AutoRefresh seconds={10} />

      {!snapshot.installed ? (
        <p className="notice">
          As tabelas do pg-boss ainda não existem. Suba o worker uma vez (
          <code>pnpm --filter @megabot/worker dev</code>) para criá-las.
        </p>
      ) : (
        <>
          <QueuesTable queues={snapshot.queues} selected={selected} />
          <h2>{selected ? `Jobs recentes — ${selected}` : 'Jobs recentes'}</h2>
          {jobs?.status === 'ok' ? (
            <JobsTable jobs={jobs.data} />
          ) : (
            <p className="muted">
              Selecione uma fila acima para ver seus jobs. Os payloads nunca são exibidos.
            </p>
          )}
        </>
      )}
    </section>
  );
}
