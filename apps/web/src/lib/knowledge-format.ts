import type { KnowledgeSource } from './knowledge';

/** Como cada status aparece na tela (rótulo + cor da bolinha). */
export const STATUS_LABEL: Record<string, string> = {
  pending: 'Na fila',
  processing: 'Processando',
  ready: 'Pronta',
  failed: 'Falhou',
};

export const STATUS_TONE: Record<string, 'ok' | 'warning' | 'danger' | ''> = {
  pending: 'warning',
  processing: 'warning',
  ready: 'ok',
  failed: 'danger',
};

export const KIND_LABEL: Record<string, string> = {
  upload: 'Arquivo',
  url: 'Site',
  text: 'Texto',
};

export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;
export const statusClass = (status: string) => {
  const tone = STATUS_TONE[status];
  return tone ? `status status-${tone}` : 'status';
};
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString('pt-BR');

/** Resumo de uma linha da lista: o que a pessoa precisa saber em uma frase. */
export function sourceSummary(source: KnowledgeSource): string {
  if (source.status === 'failed') return source.errorMessage ?? 'Falhou ao processar.';
  if (source.status === 'ready') {
    return `${formatNumber(source.chunkCount)} trecho${source.chunkCount === 1 ? '' : 's'} indexado${
      source.chunkCount === 1 ? '' : 's'
    }.`;
  }
  if (source.status === 'processing') return `Processando… ${source.progress}%`;
  return 'Aguardando o processamento começar.';
}

/** `true` quando ainda vale atualizar a tela sozinha (algo em andamento). */
export const hasWorkInProgress = (sources: KnowledgeSource[]): boolean =>
  sources.some((source) => source.status === 'pending' || source.status === 'processing');
