import Link from 'next/link';
import type { KnowledgeSource } from '@/lib/knowledge';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  kindLabel,
  sourceSummary,
  statusClass,
  statusLabel,
} from '@/lib/knowledge-format';

/** Lista de fontes. Componente puro (testável sem o Next). */
export function KnowledgeSourcesTable({ sources }: { sources: KnowledgeSource[] }) {
  if (sources.length === 0) {
    return (
      <p className="muted">
        Nenhuma fonte ainda. Envie um arquivo, importe o site da empresa ou cole um texto acima.
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Fonte</th>
            <th>Tipo</th>
            <th>Situação</th>
            <th className="num">Trechos</th>
            <th className="num">Tamanho</th>
            <th>Atualizada</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.id}>
              <td>
                <Link href={`/knowledge/${source.id}`}>{source.title}</Link>
                <div className="muted">{sourceSummary(source)}</div>
              </td>
              <td>{kindLabel(source.kind)}</td>
              <td>
                <span className={statusClass(source.status)}>{statusLabel(source.status)}</span>
                {source.status === 'processing' ? (
                  <progress max={100} value={source.progress} aria-label="Progresso" />
                ) : null}
              </td>
              <td className="num">{formatNumber(source.chunkCount)}</td>
              <td className="num">{formatBytes(source.byteSize)}</td>
              <td>{formatDateTime(source.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
