import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { KnowledgeError, decodeText, extractDocument, pdfToText } from '../src';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));
const bytes = (text: string) => new TextEncoder().encode(text);

describe('PDF -> texto', () => {
  it('lê o texto com acentos, uma seção por página', async () => {
    const { text, pageCount } = await pdfToText(fixture('politica.pdf'));
    assert.equal(pageCount, 2);
    assert.match(text, /^## Página 1\n/);
    assert.match(text, /Política de trocas e devoluções/);
    assert.match(text, /até 30 dias após a compra/);
    assert.match(text, /## Página 2\n\nAtendimento de segunda a sexta/);
  });

  it('PDF corrompido vira erro legível', async () => {
    await assert.rejects(
      pdfToText(bytes('%PDF-1.4 isto não é um PDF de verdade')),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, 'pdf_invalido');
        assert.equal(error.retryable, false);
        assert.match(error.message, /corrompido ou protegido/);
        return true;
      },
    );
  });
});

describe('extractDocument', () => {
  it('PDF escaneado (sem texto) explica que falta OCR', async () => {
    await assert.rejects(
      extractDocument({ bytes: fixture('escaneado.pdf'), format: 'pdf' }),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, 'sem_texto');
        assert.match(error.message, /escaneado/);
        return true;
      },
    );
  });

  it('arquivo vazio e documento sem texto', async () => {
    await assert.rejects(extractDocument({ bytes: new Uint8Array(), format: 'text' }), {
      code: 'documento_vazio',
    });
    await assert.rejects(extractDocument({ bytes: bytes('   \n\n  '), format: 'text' }), {
      code: 'sem_texto',
    });
    await assert.rejects(
      extractDocument({
        bytes: bytes('<html><body><nav>menu</nav></body></html>'),
        format: 'html',
      }),
      { code: 'sem_texto' },
    );
  });

  it('texto e markdown passam direto (sem espaços no fim das linhas)', async () => {
    const result = await extractDocument({
      bytes: bytes('  Primeira linha   \r\nSegunda linha\t\n\n'),
      format: 'text',
    });
    // Espaços no fim de cada linha e nas pontas do documento saem; o resto fica como está.
    assert.equal(result.text, 'Primeira linha\nSegunda linha');
    assert.equal(result.format, 'text');
    assert.equal(result.title, null);
    assert.deepEqual(result.warnings, []);
  });

  it('planilha: devolve abas e avisos; PDF: devolve número de páginas; HTML: devolve título', async () => {
    const sheet = await extractDocument({ bytes: fixture('catalogo.xlsx'), format: 'xlsx' });
    assert.deepEqual(sheet.sheetNames, ['Produtos', 'FAQ']);
    assert.match(sheet.text, /## Aba: Produtos/);

    const pdf = await extractDocument({ bytes: fixture('politica.pdf'), format: 'pdf' });
    assert.equal(pdf.pageCount, 2);

    const html = await extractDocument({
      bytes: bytes('<html><head><title>Minha Loja</title></head><body><p>Olá</p></body></html>'),
      format: 'html',
    });
    assert.equal(html.title, 'Minha Loja');
    assert.equal(html.text, 'Olá');
  });

  it('CSV usa o nome do arquivo como rótulo dos avisos', async () => {
    const result = await extractDocument({
      bytes: bytes('SKU,Nome\nA1,Caneca\n'),
      format: 'csv',
      fileName: 'produtos.csv',
    });
    assert.equal(result.text, 'SKU: A1 | Nome: Caneca');
  });
});

describe('decodeText', () => {
  it('UTF-8, com e sem BOM', () => {
    assert.equal(decodeText(bytes('ação e coração')), 'ação e coração');
    assert.equal(decodeText(bytes('﻿com BOM')), 'com BOM');
  });

  it('cai para windows-1252 quando os bytes não são UTF-8 válido (páginas antigas)', () => {
    // "ação" em windows-1252/latin-1.
    const latin = Uint8Array.from([0x61, 0xe7, 0xe3, 0x6f]);
    assert.equal(decodeText(latin), 'ação');
    assert.equal(decodeText(latin, 'iso-8859-1'), 'ação');
  });

  it('charset declarado tem prioridade, e um charset inventado não quebra', () => {
    assert.equal(decodeText(bytes('ok'), 'charset-que-nao-existe'), 'ok');
    assert.equal(decodeText(bytes('acentuação'), 'utf-8'), 'acentuação');
  });

  it('HTML com <meta charset=iso-8859-1> é lido certo pelo extractDocument', async () => {
    const head = Buffer.from('<html><head><meta charset="iso-8859-1"></head><body><p>', 'latin1');
    const body = Buffer.from('Promoção de inverno', 'latin1');
    const tail = Buffer.from('</p></body></html>', 'latin1');
    const result = await extractDocument({
      bytes: new Uint8Array(Buffer.concat([head, body, tail])),
      format: 'html',
    });
    assert.equal(result.text, 'Promoção de inverno');
  });
});
