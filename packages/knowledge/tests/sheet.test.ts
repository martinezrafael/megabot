import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assertStrict from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KnowledgeError,
  MAX_SHEET_ROWS,
  delimitedToText,
  parseDelimited,
  xlsxToText,
} from '../src';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

describe('planilha -> texto', () => {
  it('xlsx: uma seção por aba e cada linha com "Coluna: valor"', async () => {
    const { text, sheetNames, warnings } = await xlsxToText(fixture('catalogo.xlsx'));
    assert.deepEqual(sheetNames, ['Produtos', 'FAQ']);
    assert.deepEqual(warnings, []);
    assert.equal(
      text,
      [
        '## Aba: Produtos',
        '',
        'SKU: CAM-001 | Nome: Camiseta preta | Preço: 79.9 | Estoque: 12',
        'SKU: CAL-002 | Nome: Calça jeans | Preço: 199.5 | Estoque: 0',
        'SKU: CAP-003 | Nome: Boné | Preço: 49 | Estoque: 7',
        '',
        '## Aba: FAQ',
        '',
        'Pergunta: Qual o prazo de entrega? | Resposta: De 3 a 7 dias úteis.',
        'Pergunta: Vocês entregam no Nordeste? | Resposta: Sim, em todo o Brasil.',
      ].join('\n'),
    );
  });

  it('xlsx inválido vira erro legível', async () => {
    await assert.rejects(
      xlsxToText(new TextEncoder().encode('isto não é uma planilha')),
      (error: unknown) => {
        assertStrict.ok(error instanceof KnowledgeError);
        assertStrict.equal(error.code, 'planilha_invalida');
        assertStrict.match(error.message, /\.xlsx/);
        return true;
      },
    );
  });

  it('CSV: aspas, separador dentro de aspas, aspas escapadas e quebra de linha no campo', () => {
    const rows = parseDelimited(
      'nome,obs\n"Camiseta, preta","tamanho ""M"""\n"Calça","linha 1\nlinha 2"\n',
      ',',
    );
    assert.deepEqual(rows, [
      ['nome', 'obs'],
      ['Camiseta, preta', 'tamanho "M"'],
      ['Calça', 'linha 1\nlinha 2'],
    ]);
  });

  it('CSV/TSV -> texto usa a primeira linha como cabeçalho e ignora células vazias', () => {
    const csv = delimitedToText('SKU,Nome,Preço\nA1,Caneca,25\nA2,,30\n', ',', 'produtos.csv');
    assert.equal(
      csv.text,
      ['SKU: A1 | Nome: Caneca | Preço: 25', 'SKU: A2 | Preço: 30'].join('\n'),
    );

    const tsv = delimitedToText('a\tb\n1\t2\n', '\t');
    assert.equal(tsv.text, 'a: 1 | b: 2');
  });

  it('CSV só com cabeçalho vira a própria linha; CSV vazio vira texto vazio', () => {
    assert.equal(delimitedToText('a,b,c\n', ',').text, 'a | b | c');
    assert.equal(delimitedToText('', ',').text, '');
    assert.equal(delimitedToText('\n\n', ',').text, '');
  });

  it('planilha gigante é truncada com aviso', () => {
    const lines = ['id,valor'];
    for (let i = 0; i < MAX_SHEET_ROWS + 10; i += 1) lines.push(`${i},${i * 2}`);
    const { text, warnings } = delimitedToText(lines.join('\n'), ',', 'grande.csv');
    assert.equal(text.split('\n').length, MAX_SHEET_ROWS);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /primeiras 5000 linhas/);
  });

  it('BOM do Excel não vira lixo na primeira coluna', () => {
    const { text } = delimitedToText('﻿SKU,Nome\nA1,Caneca\n', ',');
    assert.equal(text, 'SKU: A1 | Nome: Caneca');
  });
});
