'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiRequest } from '@/lib/api-browser';
import {
  toneLabel,
  toolLabel,
  versionLabel,
  type AgentConfig,
  type AgentConfigOptions,
} from '@/lib/agent-config';
import { formatDateTime } from '@/lib/knowledge-format';

/**
 * Histórico de versões com o botão de restaurar.
 *
 * Restaurar NÃO apaga nada: a API copia a versão escolhida para uma versão nova. Por isso a
 * tabela fala em "criar uma versão nova", que é o que de fato acontece.
 */
export function AgentVersionHistoryPanel(props: {
  versions: AgentConfig[];
  total: number;
  activeVersion: number;
  options: AgentConfigOptions;
}) {
  const router = useRouter();
  return <AgentVersionHistory {...props} onRestored={() => router.refresh()} />;
}

/**
 * A tabela em si. Não usa o router (quem usa é o painel acima), então é renderizável e testável
 * fora do Next — é o mesmo arranjo das outras telas.
 */
export function AgentVersionHistory({
  versions,
  total,
  activeVersion,
  options,
  onRestored,
}: {
  versions: AgentConfig[];
  total: number;
  activeVersion: number;
  options: AgentConfigOptions;
  /** Chamado depois de um rollback bem-sucedido, para a tela recarregar. */
  onRestored?: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [aberta, setAberta] = useState<number | null>(null);

  if (versions.length === 0) {
    return (
      <p className="muted">
        Nenhuma versão salva ainda. A primeira aparece aqui assim que você salvar.
      </p>
    );
  }

  async function restore(version: number) {
    setBusy(version);
    setError(null);
    setSuccess(null);
    const result = await apiRequest<AgentConfig>(`/agent-config/versions/${version}/restore`, {
      method: 'POST',
    });
    setBusy(null);
    if (!result.ok || !result.data) {
      return setError(result.error ?? 'Não foi possível restaurar.');
    }
    setSuccess(
      `Versão ${version} restaurada: ela virou a versão ${result.data.version}, que está no ar.`,
    );
    setAberta(null);
    onRestored?.();
  }

  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="success">{success}</p> : null}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Versão</th>
              <th>Quando</th>
              <th>Quem</th>
              <th>Nome e tom</th>
              <th className="num">Regras</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.version}>
                <td>
                  {versionLabel(version)}
                  {version.active ? <span className="status-ok"> no ar</span> : null}
                </td>
                <td>{formatDateTime(version.createdAt)}</td>
                <td>{version.createdByName ?? <span className="muted">conta removida</span>}</td>
                <td>
                  {version.name}
                  <div className="muted">{toneLabel(options.tones, version.tone)}</div>
                </td>
                <td className="num">{version.rules.length}</td>
                <td className="actions">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      setAberta((atual) => (atual === version.version ? null : version.version))
                    }
                    aria-expanded={aberta === version.version}
                  >
                    {aberta === version.version ? 'Esconder' : 'Ver conteúdo'}
                  </button>
                  {version.active ? null : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => restore(version.version)}
                    >
                      {busy === version.version ? 'Restaurando…' : 'Restaurar'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {aberta !== null ? (
        <VersionDetails version={versions.find((v) => v.version === aberta)!} options={options} />
      ) : null}

      <p className="muted">
        {total} {total === 1 ? 'versão' : 'versões'} no total. A versão {activeVersion} é a que o
        atendimento está usando. Restaurar cria uma versão nova com o conteúdo da escolhida — o
        histórico nunca é apagado.
      </p>
    </>
  );
}

/** O conteúdo completo de uma versão, para comparar antes de restaurar. */
function VersionDetails({
  version,
  options,
}: {
  version: AgentConfig;
  options: AgentConfigOptions;
}) {
  return (
    <div className="card">
      <h3>{versionLabel(version)}</h3>
      <dl>
        <dt>Nome</dt>
        <dd>{version.name}</dd>
        <dt>Tom</dt>
        <dd>{toneLabel(options.tones, version.tone)}</dd>
        <dt>Apresentação</dt>
        <dd className="chunk-content">{version.greeting}</dd>
        <dt>Ferramentas</dt>
        <dd>
          {version.tools.length === 0
            ? 'nenhuma'
            : version.tools.map((tool) => toolLabel(options.tools, tool)).join(', ')}
        </dd>
        <dt>Regras</dt>
        <dd>
          {version.rules.length === 0 ? (
            'nenhuma'
          ) : (
            <ol>
              {version.rules.map((rule, index) => (
                <li key={`${version.version}-${index}`}>{rule}</li>
              ))}
            </ol>
          )}
        </dd>
      </dl>
    </div>
  );
}
