/**
 * Gera os arquivos de teste (PDF e planilha) usados pelos testes de extração.
 * Rode `pnpm --filter @megabot/knowledge fixtures` se precisar recriá-los.
 * Eles ficam versionados porque extração de PDF/planilha só se testa de verdade com arquivo real.
 */
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const DIR = join(__dirname, '..', 'tests', 'fixtures');

function writePdf(file: string, build: (doc: PDFKit.PDFDocument) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = createWriteStream(join(DIR, file));
    stream.on('finish', () => resolve());
    stream.on('error', reject);
    doc.pipe(stream);
    build(doc);
    doc.end();
  });
}

async function main() {
  await writePdf('politica.pdf', (doc) => {
    doc.fontSize(18).text('Política de trocas e devoluções');
    doc
      .moveDown()
      .fontSize(12)
      .text(
        'O cliente pode trocar o produto em até 30 dias após a compra, desde que a etiqueta esteja intacta.',
      );
    doc
      .moveDown()
      .text('Para devoluções, o frete é por conta da loja quando houver defeito de fabricação.');
    doc.addPage().fontSize(12).text('Atendimento de segunda a sexta, das 9h às 18h.');
  });

  // PDF "escaneado": só um retângulo, nenhum texto (é o caso que precisa de OCR).
  await writePdf('escaneado.pdf', (doc) => {
    doc.rect(60, 60, 400, 300).fill('#cccccc');
  });

  const workbook = new ExcelJS.Workbook();
  const produtos = workbook.addWorksheet('Produtos');
  produtos.addRow(['SKU', 'Nome', 'Preço', 'Estoque']);
  produtos.addRow(['CAM-001', 'Camiseta preta', 79.9, 12]);
  produtos.addRow(['CAL-002', 'Calça jeans', 199.5, 0]);
  produtos.addRow([]);
  produtos.addRow(['CAP-003', 'Boné', 49, 7]);
  const faq = workbook.addWorksheet('FAQ');
  faq.addRow(['Pergunta', 'Resposta']);
  faq.addRow(['Qual o prazo de entrega?', 'De 3 a 7 dias úteis.']);
  faq.addRow(['Vocês entregam no Nordeste?', 'Sim, em todo o Brasil.']);
  await workbook.xlsx.writeFile(join(DIR, 'catalogo.xlsx'));

  console.info(`Arquivos de teste gerados em ${DIR}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
