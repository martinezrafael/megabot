import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { KnowledgeChunkList } from '@/components/knowledge-chunk-list';
import { KnowledgeSourceActions } from '@/components/knowledge-source-actions';
import { fetchKnowledgeChunks, fetchKnowledgeSource } from '@/lib/knowledge';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  kindLabel,
  statusClass,
  statusLabel,
} from '@/lib/knowledge-format';
import { getMe } from '@/lib/server-session';
import { knowledgeOptions } from '../page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fonte · Megabot' };

const PAGE_SIZE = 50;

/** Detalhe de uma fonte: situação, erro (se houver) e os trechos, com edição. */
export default async function KnowledgeSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pagina?: string }>;
}) {
  const me = await getMe();
  if (!me) redirect('/sign-in');

  const [{ id }, query, options] = await Promise.all([params, searchParams, knowledgeOptions()]);
  const page = Math.max(Number(query.pagina ?? '1') || 1, 1);

  const source = await fetchKnowledgeSource(options, id);
  if (source.status !== 'ok') notFound();

  const chunks = await fetchKnowledgeChunks(options, id, {
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const inProgress = source.data.status === 'pending' || source.data.status === 'processing';
  const totalPages = chunks.status === 'ok' ? Math.ceil(chunks.data.total / PAGE_SIZE) : 1;

  return (
    <section>
      <p>
        <Link href="/knowledge">← Base de conhecimento</Link>
      </p>
      <h1>{source.data.title}</h1>
      {inProgress ? <AutoRefresh seconds={10} /> : null}

      <dl>
        <dt>Situação</dt>
        <dd>
          <span className={statusClass(source.data.status)}>{statusLabel(source.data.status)}</span>
          {source.data.status === 'processing' ? (
            <progress max={100} value={source.data.progress} aria-label="Progresso" />
          ) : null}
        </dd>
        <dt>Tipo</dt>
        <dd>
          {kindLabel(source.data.kind)}
          {source.data.sourceUrl ? (
            <>
              {' — '}
              <a href={source.data.sourceUrl} target="_blank" rel="noreferrer noopener">
                {source.data.sourceUrl}
              </a>
            </>
          ) : null}
          {source.data.fileName ? ` — ${source.data.fileName}` : null}
        </dd>
        <dt>Trechos</dt>
        <dd>{formatNumber(source.data.chunkCount)}</dd>
        <dt>Texto extraído</dt>
        <dd>
          {source.data.charCount === null
            ? '—'
            : `${formatNumber(source.data.charCount)} caracteres`}
        </dd>
        <dt>Tamanho do arquivo</dt>
        <dd>{formatBytes(source.data.byteSize)}</dd>
        <dt>Última indexação</dt>
        <dd>{formatDateTime(source.data.lastIngestedAt)}</dd>
        <dt>Modelo de embedding</dt>
        <dd>{source.data.embeddingModel ?? '—'}</dd>
      </dl>

      {source.data.status === 'failed' ? (
        <p className="error">
          {source.data.errorMessage ?? 'Falhou ao processar.'}
          {source.data.errorCode ? (
            <span className="muted"> (código: {source.data.errorCode})</span>
          ) : null}
        </p>
      ) : null}

      <KnowledgeSourceActions sourceId={source.data.id} processing={inProgress} />

      <h2>Trechos</h2>
      {chunks.status === 'ok' ? (
        <>
          <KnowledgeChunkList chunks={chunks.data.items} total={chunks.data.total} />
          {totalPages > 1 ? (
            <p className="actions">
              {page > 1 ? (
                <Link href={`/knowledge/${id}?pagina=${page - 1}`}>← Anteriores</Link>
              ) : null}
              <span className="muted">
                Página {page} de {totalPages}
              </span>
              {page < totalPages ? (
                <Link href={`/knowledge/${id}?pagina=${page + 1}`}>Próximos →</Link>
              ) : null}
            </p>
          ) : null}
        </>
      ) : (
        <p className="notice">Não foi possível carregar os trechos agora.</p>
      )}
    </section>
  );
}
