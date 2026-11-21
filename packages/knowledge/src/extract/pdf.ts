import { knowledgeError } from '../errors';

export interface PdfExtraction {
  text: string;
  pageCount: number;
}

/**
 * PDF -> texto, página por página (cada página virando a seção `## Página N`, que o divisor de
 * trechos usa como referência: dá para dizer ao cliente "isto veio da página 3").
 *
 * Usa o unpdf (pdf.js empacotado para Node). PDF que é só imagem (documento escaneado) não tem
 * texto para extrair: isso vira o erro `sem_texto`, com a explicação de que falta OCR.
 */
export async function pdfToText(bytes: Uint8Array): Promise<PdfExtraction> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pages: string[];
  try {
    // O pdf.js pode ficar com o buffer; passar uma copia evita surpresa para quem chamou.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const extracted = await extractText(pdf, { mergePages: false });
    pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
  } catch (error) {
    throw knowledgeError(
      'pdf_invalido',
      'Não foi possível ler este PDF. Ele pode estar corrompido ou protegido por senha.',
      false,
      error,
    );
  }

  const sections = pages
    .map((page, index) => ({ page: index + 1, text: page.replace(/\r\n?/g, '\n').trim() }))
    .filter((section) => section.text.length > 0)
    .map((section) => `## Página ${section.page}\n\n${section.text}`);

  return { text: sections.join('\n\n'), pageCount: pages.length };
}
