import { KnowledgeError, knowledgeError } from './errors';

/** Formatos que sabemos transformar em texto. */
export type DocumentFormat = 'html' | 'pdf' | 'text' | 'markdown' | 'csv' | 'tsv' | 'xlsx';

/** Tamanho máximo padrão de um documento (20 MB). Configurável pela API/worker. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const BY_EXTENSION: Record<string, DocumentFormat> = {
  htm: 'html',
  html: 'html',
  xhtml: 'html',
  pdf: 'pdf',
  txt: 'text',
  text: 'text',
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  tsv: 'tsv',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
};

const BY_MIME: Record<string, DocumentFormat> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
};

/** Formatos que o upload aceita, em texto, para mensagens de erro e para a tela. */
export const SUPPORTED_UPLOAD_EXTENSIONS = [
  '.pdf',
  '.html',
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.xlsx',
] as const;

export const extensionOf = (fileName: string | undefined | null): string =>
  fileName?.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';

/** Tipo declarado sem os parâmetros (`text/html; charset=utf-8` -> `text/html`). */
export const normalizeMimeType = (mimeType: string | undefined | null): string =>
  (mimeType ?? '').split(';')[0]!.trim().toLowerCase();

const UNSUPPORTED_HINTS: Record<string, string> = {
  doc: 'Converta para PDF e envie de novo.',
  docx: 'Converta para PDF e envie de novo.',
  xls: 'Salve como .xlsx (ou .csv) e envie de novo.',
  ppt: 'Converta para PDF e envie de novo.',
  pptx: 'Converta para PDF e envie de novo.',
  zip: 'Envie os arquivos separadamente.',
  rar: 'Envie os arquivos separadamente.',
  json: 'Converta para .csv ou cole o conteúdo como texto.',
  xml: 'Converta para .csv ou cole o conteúdo como texto.',
};

/**
 * Descobre o formato pelo tipo declarado e, na falta dele, pela extensão do nome do arquivo.
 * O nome tem prioridade quando o tipo é genérico (`application/octet-stream`), que é o que
 * navegadores e servidores mandam quando não sabem o que é.
 */
export function detectFormat(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): DocumentFormat {
  const mime = normalizeMimeType(input.mimeType);
  const extension = extensionOf(input.fileName);
  const byExtension = BY_EXTENSION[extension];
  const byMime = BY_MIME[mime];

  if (byMime && (!byExtension || mime !== 'text/plain')) return byMime;
  if (byExtension) return byExtension;
  if (byMime) return byMime;
  // text/* desconhecido (ex.: text/x-log) ainda é texto.
  if (mime.startsWith('text/')) return 'text';

  const hint = UNSUPPORTED_HINTS[extension];
  throw knowledgeError(
    'formato_nao_suportado',
    `Não sei ler este tipo de arquivo${extension ? ` (.${extension})` : mime ? ` (${mime})` : ''}. ` +
      `Aceitamos ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}.${hint ? ` ${hint}` : ''}`,
  );
}

/** `true` se `detectFormat` reconheceria a entrada. */
export function isSupportedDocument(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  try {
    detectFormat(input);
    return true;
  } catch (error) {
    if (error instanceof KnowledgeError) return false;
    throw error;
  }
}

export function assertWithinSize(byteSize: number, maxBytes = DEFAULT_MAX_BYTES): void {
  if (byteSize > maxBytes) {
    throw knowledgeError(
      'arquivo_grande',
      `O arquivo tem ${formatBytes(byteSize)} e o limite é ${formatBytes(maxBytes)}. ` +
        'Divida o conteúdo em arquivos menores.',
    );
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
