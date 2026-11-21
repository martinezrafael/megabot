import ExcelJS from 'exceljs';
import { knowledgeError } from '../errors';

/**
 * Planilhas -> texto. Cada aba vira a seção `## Aba: <nome>` e cada linha vira uma frase
 * `Coluna: valor | Coluna: valor`, usando a primeira linha como cabeçalho.
 *
 * Por que assim: um trecho precisa fazer sentido sozinho para o agente responder. "79,90" não diz
 * nada; "SKU: CAM-001 | Nome: Camiseta preta | Preço: 79.9" responde "quanto custa a camiseta?".
 */

/** Teto de linhas por aba: planilha gigante viraria uma base inútil (e caríssima de embeddar). */
export const MAX_SHEET_ROWS = 5000;

export interface SheetExtraction {
  text: string;
  sheetNames: string[];
  warnings: string[];
}

const cellToText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const rich = value as { text?: unknown; result?: unknown; hyperlink?: unknown };
    if (typeof rich.text === 'string') return rich.text.trim();
    if (rich.result !== undefined && rich.result !== null) return String(rich.result).trim();
    if (typeof rich.hyperlink === 'string') return rich.hyperlink.trim();
    return '';
  }
  return String(value).trim();
};

function rowsToText(rows: string[][], warnings: string[], label: string): string {
  const nonEmpty = rows.filter((row) => row.some((cell) => cell !== ''));
  if (nonEmpty.length === 0) return '';

  const [header, ...body] = nonEmpty;
  const headers = (header ?? []).map((cell) => cell.trim());
  // Sem corpo, a própria linha de cabeçalho é o conteúdo.
  if (body.length === 0) return headers.filter(Boolean).join(' | ');

  const limited = body.slice(0, MAX_SHEET_ROWS);
  if (body.length > limited.length) {
    warnings.push(
      `${label}: só as primeiras ${MAX_SHEET_ROWS} linhas foram lidas (a planilha tem ${body.length}).`,
    );
  }

  return limited
    .map((row) =>
      row
        .map((cell, index) => {
          if (cell === '') return '';
          const name = headers[index];
          return name ? `${name}: ${cell}` : cell;
        })
        .filter((part) => part !== '')
        .join(' | '),
    )
    .filter((line) => line !== '')
    .join('\n');
}

export async function xlsxToText(bytes: Uint8Array): Promise<SheetExtraction> {
  const workbook = new ExcelJS.Workbook();
  try {
    // O ExcelJS espera um Buffer do Node.
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  } catch (error) {
    throw knowledgeError(
      'planilha_invalida',
      'Não foi possível ler esta planilha. Confira se o arquivo é .xlsx e não está corrompido.',
      false,
      error,
    );
  }

  const warnings: string[] = [];
  const sheetNames: string[] = [];
  const sections: string[] = [];

  workbook.eachSheet((sheet) => {
    sheetNames.push(sheet.name);
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map(cellToText));
    });
    const text = rowsToText(rows, warnings, `Aba "${sheet.name}"`);
    if (text) sections.push(`## Aba: ${sheet.name}\n\n${text}`);
  });

  return { text: sections.join('\n\n'), sheetNames, warnings };
}

/**
 * CSV/TSV -> texto. Parser próprio (poucas linhas) que entende aspas duplas, aspas escapadas
 * (`""`), separador dentro de aspas e quebra de linha dentro de aspas.
 */
export function parseDelimited(content: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) endField();
    else if (char === '\n') endRow();
    else field += char;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

export function delimitedToText(
  content: string,
  delimiter: ',' | '\t',
  label = 'Planilha',
): SheetExtraction {
  const warnings: string[] = [];
  const text = rowsToText(parseDelimited(content, delimiter), warnings, label);
  return { text, sheetNames: [], warnings };
}
