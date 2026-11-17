import Link from 'next/link';
import type { JobSummary, QueueOverview } from '@/lib/queues';
import {
  formatDateTime,
  formatDuration,
  HEALTH_LABEL,
  queueHealth,
  shortId,
  STATE_LABEL,
} from '@/lib/queues-format';

/** Resumo das filas: uma linha por fila/DLQ. Componente puro (testável sem o Next). */
export function QueuesTable({ queues, selected }: { queues: QueueOverview[]; selected?: string }) {
  if (queues.length === 0) {
    return <p className="muted">Nenhuma fila criada ainda.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Fila</th>
            <th>Situação</th>
            <th className="num">Na fila</th>
            <th className="num">Nova tentativa</th>
            <th className="num">Executando</th>
            <th className="num">Concluídos</th>
            <th className="num">Falhas</th>
            <th className="num">Espera mais antiga</th>
            <th>Último concluído</th>
          </tr>
        </thead>
        <tbody>
          {queues.map((q) => {
            const health = queueHealth(q);
            return (
              <tr key={q.name} aria-selected={q.name === selected ? 'true' : undefined}>
                <td>
                  <Link href={`/admin/queues?queue=${encodeURIComponent(q.name)}`}>{q.name}</Link>
                  {q.isDeadLetter ? <span className="badge">DLQ</span> : null}
                </td>
                <td>
                  <span className={`status status-${health}`}>{HEALTH_LABEL[health]}</span>
                </td>
                <td className="num">
                  {q.counts.created}
                  {q.counts.deferred > 0 ? (
                    <span className="muted"> ({q.counts.deferred} agendados)</span>
                  ) : null}
                </td>
                <td className="num">{q.counts.retry}</td>
                <td className="num">{q.counts.active}</td>
                <td className="num">{q.counts.completed}</td>
                <td className="num">{q.counts.failed}</td>
                <td className="num">{formatDuration(q.oldestWaitingSeconds)}</td>
                <td>{formatDateTime(q.lastCompletedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Jobs recentes de uma fila (sem payload; só empresa e resumo do erro). */
export function JobsTable({ jobs }: { jobs: JobSummary[] }) {
  if (jobs.length === 0) return <p className="muted">Nenhum job nesta fila.</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Estado</th>
            <th>Empresa (tenant)</th>
            <th className="num">Tentativas</th>
            <th>Criado em</th>
            <th>Origem</th>
            <th>Erro</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <code title={job.id}>{shortId(job.id)}</code>
              </td>
              <td>{STATE_LABEL[job.state] ?? job.state}</td>
              <td>
                <code title={job.tenantId ?? undefined}>{shortId(job.tenantId)}</code>
              </td>
              <td className="num">
                {job.retryCount}/{job.retryLimit}
              </td>
              <td>{formatDateTime(job.createdAt)}</td>
              <td>
                {job.sourceQueue ? (
                  <>
                    {job.sourceQueue}{' '}
                    <code title={job.sourceJobId ?? undefined}>{shortId(job.sourceJobId)}</code>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {job.errorMessage ? (
                  <span title={job.errorMessage}>
                    {job.errorName ? `${job.errorName}: ` : ''}
                    {job.errorMessage}
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
