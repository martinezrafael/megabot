import { knowledgeError } from '../errors';
import { normalizeMimeType, type DocumentFormat } from '../formats';
import { htmlToText } from './html';
import { pdfToText } from './pdf';
import { delimitedToText, xlsxToText } from './sheet';

export interface ExtractInput {
  bytes: Uint8Array;
  format: DocumentFormat;
  /** Usado só em mensagens e no rótulo das planilhas. */
  fileName?: string | null;
  /** Charset declarado pelo servidor (`text/html; charset=...`), quando houver. */
  charset?: string | null;
}

export interface ExtractedDocument {
  /** Texto em "markdown simples" (ver html.ts): é a entrada do divisor de trechos. */
  text: string;
  format: DocumentFormat;
  title: string | null;
  pageCount: number | null;
  sheetNames: string[];
  /** Avisos que não impedem a ingestão (ex.: planilha truncada). */
  warnings: string[];
}

/** Charset declarado no HTML (`<meta charset=...>`), para páginas antigas em latin-1. */
function charsetFromHtml(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const match =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head) ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head);
  return match?.[1] ?? null;
}

/**
 * Bytes -> string. Tenta UTF-8 de verdade (modo estrito) e, se os bytes não forem UTF-8 válido,
 * cai para windows-1252 (o que páginas e CSVs antigos do Brasil costumam usar). Assim "ç" e "ã"
 * não viram "�".
 */
export function decodeText(bytes: Uint8Array, declaredCharset?: string | null): string {
  const normalized = (declaredCharset ?? '').trim().toLowerCase();
  const candidates = [
    ...(normalized && normalized !== 'utf-8' && normalized !== 'utf8' ? [normalized] : []),
    'utf-8',
    'windows-1252',
  ];
  for (const charset of candidates) {
    try {
      return new TextDecoder(charset, { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    } catch {
      // charset desconhecido ou bytes inválidos: tenta o próximo
    }
  }
  // Último recurso: UTF-8 tolerante (troca o que não entender por "�").
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

/** Lê o documento e devolve o texto. Lança `KnowledgeError` com mensagem para o cliente. */
export async function extractDocument(input: ExtractInput): Promise<ExtractedDocument> {
  const { bytes, format } = input;
  if (bytes.byteLength === 0) {
    throw knowledgeError('documento_vazio', 'O arquivo está vazio (0 byte).');
  }

  const base = { format, title: null, pageCount: null, sheetNames: [], warnings: [] };
  let result: ExtractedDocument;

  switch (format) {
    case 'pdf': {
      const { text, pageCount } = await pdfToText(bytes);
      result = { ...base, text, pageCount };
      break;
    }
    case 'html': {
      const { text, title } = htmlToText(
        decodeText(bytes, input.charset ?? charsetFromHtml(bytes)),
      );
      result = { ...base, text, title };
      break;
    }
    case 'xlsx': {
      const { text, sheetNames, warnings } = await xlsxToText(bytes);
      result = { ...base, text, sheetNames, warnings };
      break;
    }
    case 'csv':
    case 'tsv': {
      const label = input.fileName ?? 'Planilha';
      const { text, warnings } = delimitedToText(
        decodeText(bytes, input.charset),
        format === 'csv' ? ',' : '\t',
        label,
      );
      result = { ...base, text, warnings };
      break;
    }
    case 'text':
    case 'markdown': {
      const decoded = decodeText(bytes, input.charset)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
      result = { ...base, text: decoded };
      break;
    }
  }

  if (result.text.trim().length === 0) {
    throw knowledgeError(
      'sem_texto',
      format === 'pdf'
        ? 'Este PDF não tem texto: parece ser um documento escaneado (imagem). ' +
            'Envie uma versão com texto selecionável ou passe o conteúdo em .txt.'
        : 'Não encontrei texto neste documento.',
    );
  }
  return result;
}

export { htmlToText, pdfToText, xlsxToText, delimitedToText, normalizeMimeType };
