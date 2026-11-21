'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiRequest } from '@/lib/api-browser';
import type { KnowledgeChunk } from '@/lib/knowledge';
import { formatNumber } from '@/lib/knowledge-format';

/**
 * Trechos da fonte, com edição no lugar. Editar vale na hora; o embedding é recalculado pelo
 * worker em seguida (enquanto isso o trecho aparece como "embedding sendo recalculado").
 */
export function KnowledgeChunkList({ chunks, total }: { chunks: KnowledgeChunk[]; total: number }) {
  if (chunks.length === 0) {
    return (
      <p className="muted">
        Nenhum trecho ainda. Eles aparecem quando a fonte termina de ser processada.
      </p>
    );
  }
  return (
    <>
      <p className="muted">
        {formatNumber(total)} trecho{total === 1 ? '' : 's'}. É isto que o assistente pesquisa para
        responder.
      </p>
      <ol className="chunk-list">
        {chunks.map((chunk) => (
          <li key={chunk.id}>
            <ChunkItem chunk={chunk} />
          </li>
        ))}
      </ol>
    </>
  );
}

/** O texto do trecho já começa com o título da seção (ele vai junto para o embedding). */
const repeatsHeading = (chunk: KnowledgeChunk) =>
  Boolean(chunk.heading) && chunk.content.trimStart().startsWith(chunk.heading!);

function ChunkItem({ chunk }: { chunk: KnowledgeChunk }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(chunk.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/knowledge/chunks/${chunk.id}`, {
      method: 'PATCH',
      json: { content },
    });
    setBusy(false);
    if (!result.ok) return setError(result.error ?? 'Não foi possível salvar.');
    setEditing(false);
    router.refresh();
  }

  async function remove() {
    if (!window.confirm('Apagar este trecho?')) return;
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/knowledge/chunks/${chunk.id}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) return setError(result.error ?? 'Não foi possível apagar.');
    router.refresh();
  }

  return (
    <article className="chunk">
      <header>
        <span className="badge">#{chunk.position + 1}</span>
        {chunk.heading && !repeatsHeading(chunk) ? (
          <span className="chunk-heading">{chunk.heading}</span>
        ) : null}
        {chunk.edited ? <span className="badge">editado</span> : null}
        {chunk.embeddingStale ? <span className="badge">recalculando busca</span> : null}
        {!chunk.hasEmbedding ? <span className="badge">sem embedding</span> : null}
      </header>

      {editing ? (
        <>
          <textarea
            value={content}
            rows={Math.min(14, Math.max(4, Math.ceil(content.length / 80)))}
            onChange={(event) => setContent(event.target.value)}
            aria-label={`Conteúdo do trecho ${chunk.position + 1}`}
          />
          <div className="actions">
            <button type="button" className="primary" onClick={save} disabled={busy}>
              {busy ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              type="button"
              onClick={() => {
                setContent(chunk.content);
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
            >
              Cancelar
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="chunk-content">{chunk.content}</p>
          <div className="actions">
            <button type="button" onClick={() => setEditing(true)}>
              Editar
            </button>
            <button type="button" onClick={remove} disabled={busy}>
              Apagar
            </button>
            <span className="muted">{formatNumber(chunk.charCount)} caracteres</span>
          </div>
        </>
      )}
      {error ? <p className="error">{error}</p> : null}
    </article>
  );
}
