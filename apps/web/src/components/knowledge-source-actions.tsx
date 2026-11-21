'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiRequest } from '@/lib/api-browser';

/** Botões de "processar de novo" e "apagar" de uma fonte. */
export function KnowledgeSourceActions({
  sourceId,
  processing,
}: {
  sourceId: string;
  processing: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reingest() {
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/knowledge/sources/${sourceId}/reingest`, { method: 'POST' });
    setBusy(false);
    if (!result.ok) return setError(result.error ?? 'Não foi possível reprocessar.');
    router.refresh();
  }

  async function remove() {
    if (!window.confirm('Apagar esta fonte e todos os seus trechos?')) return;
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/knowledge/sources/${sourceId}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) return setError(result.error ?? 'Não foi possível apagar.');
    router.push('/knowledge');
    router.refresh();
  }

  return (
    <>
      <div className="actions">
        <button type="button" onClick={reingest} disabled={busy || processing}>
          Processar de novo
        </button>
        <button type="button" onClick={remove} disabled={busy}>
          Apagar fonte
        </button>
      </div>
      {processing ? <p className="muted">Já está processando agora.</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
