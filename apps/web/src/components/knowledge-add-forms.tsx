'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api-browser';
import type { KnowledgeLimits } from '@/lib/knowledge';
import { formatBytes } from '@/lib/knowledge-format';

type Tab = 'arquivo' | 'site' | 'texto';

/**
 * As três formas de alimentar a base: enviar arquivo, importar um site e colar texto.
 * Depois de criar a fonte, `router.refresh()` recarrega a lista (que já mostra "Na fila").
 */
export function KnowledgeAddForms({ limits }: { limits: KnowledgeLimits }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('arquivo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function start() {
    setBusy(true);
    setError(null);
    setSuccess(null);
  }

  function finish(result: { ok: boolean; error?: string }, message: string) {
    setBusy(false);
    if (!result.ok) return setError(result.error ?? 'Não foi possível adicionar.');
    setSuccess(message);
    router.refresh();
  }

  async function sendFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return setError('Escolha um arquivo.');
    if (file.size > limits.maxUploadBytes) {
      return setError(
        `O arquivo tem ${formatBytes(file.size)} e o limite é ${formatBytes(limits.maxUploadBytes)}.`,
      );
    }
    start();
    // O corpo é o próprio arquivo (sem multipart): o nome vai na query.
    const result = await apiRequest(
      `/knowledge/sources/upload?fileName=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      },
    );
    if (result.ok && fileInput.current) fileInput.current.value = '';
    finish(result, `"${file.name}" enviado. Estamos processando.`);
  }

  async function sendUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // O elemento tem de ser guardado ANTES do await: depois do handler, currentTarget fica nulo.
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    start();
    const result = await apiRequest('/knowledge/sources', {
      method: 'POST',
      json: { kind: 'url', url: String(form.get('url') ?? '').trim() },
    });
    if (result.ok) formEl.reset();
    finish(result, 'Site adicionado. Estamos lendo a página.');
  }

  async function sendText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const title = String(form.get('title') ?? '').trim();
    start();
    const result = await apiRequest('/knowledge/sources', {
      method: 'POST',
      json: {
        kind: 'text',
        text: String(form.get('text') ?? ''),
        ...(title ? { title } : {}),
      },
    });
    if (result.ok) formEl.reset();
    finish(result, 'Texto adicionado. Estamos processando.');
  }

  return (
    <section className="card">
      <div className="tabs" role="tablist" aria-label="Como adicionar conteúdo">
        {(
          [
            ['arquivo', 'Enviar arquivo'],
            ['site', 'Importar site'],
            ['texto', 'Colar texto'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'arquivo' ? (
        <form onSubmit={sendFile}>
          <label htmlFor="kb-file">Arquivo</label>
          <input
            id="kb-file"
            ref={fileInput}
            type="file"
            accept={limits.acceptedExtensions.join(',')}
            required
          />
          <p className="muted">
            Aceitamos {limits.acceptedExtensions.join(', ')} — até{' '}
            {formatBytes(limits.maxUploadBytes)}. PDF escaneado (foto) não funciona: precisa ter
            texto selecionável.
          </p>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Enviando…' : 'Enviar arquivo'}
          </button>
        </form>
      ) : null}

      {tab === 'site' ? (
        <form onSubmit={sendUrl}>
          <label htmlFor="kb-url">Endereço da página</label>
          <input
            id="kb-url"
            name="url"
            type="url"
            placeholder="https://suaempresa.com.br/perguntas-frequentes"
            required
          />
          <p className="muted">
            Lemos uma página por vez (a página precisa estar pública, sem login).
          </p>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Importando…' : 'Importar página'}
          </button>
        </form>
      ) : null}

      {tab === 'texto' ? (
        <form onSubmit={sendText}>
          <label htmlFor="kb-title">Nome (opcional)</label>
          <input id="kb-title" name="title" type="text" placeholder="Perguntas frequentes" />
          <label htmlFor="kb-text">Conteúdo</label>
          <textarea
            id="kb-text"
            name="text"
            rows={8}
            required
            placeholder={
              'Horário de atendimento: segunda a sexta, 9h às 18h.\nFrete grátis acima de R$ 199.'
            }
          />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Salvando…' : 'Adicionar texto'}
          </button>
        </form>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="success">{success}</p> : null}
    </section>
  );
}
