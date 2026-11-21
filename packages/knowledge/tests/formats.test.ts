import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAX_BYTES,
  KnowledgeError,
  assertWithinSize,
  detectFormat,
  extensionOf,
  formatBytes,
  isSupportedDocument,
  normalizeMimeType,
} from '../src';

describe('detecção de formato', () => {
  const cases: Array<[{ mimeType?: string; fileName?: string }, string]> = [
    [{ mimeType: 'application/pdf' }, 'pdf'],
    [{ fileName: 'manual.PDF' }, 'pdf'],
    [{ mimeType: 'text/html; charset=utf-8' }, 'html'],
    [{ fileName: 'sobre.html' }, 'html'],
    [{ mimeType: 'text/plain', fileName: 'notas.txt' }, 'text'],
    [{ mimeType: 'text/plain', fileName: 'leia.md' }, 'markdown'],
    // Servidores mandam CSV como text/plain: o nome do arquivo decide.
    [{ mimeType: 'text/plain', fileName: 'produtos.csv' }, 'csv'],
    [{ fileName: 'dados.tsv' }, 'tsv'],
    [{ mimeType: 'text/csv' }, 'csv'],
    [
      {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'catalogo.xlsx',
      },
      'xlsx',
    ],
    // Tipo genérico do navegador: vale a extensão.
    [{ mimeType: 'application/octet-stream', fileName: 'catalogo.xlsx' }, 'xlsx'],
    [{ mimeType: 'text/x-log' }, 'text'],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(detectFormat(input), expected);
      assert.equal(isSupportedDocument(input), true);
    });
  }

  it('formato não suportado explica o que fazer', () => {
    for (const [input, hint] of [
      [{ fileName: 'contrato.docx' }, /Converta para PDF/],
      [{ fileName: 'planilha.xls' }, /\.xlsx/],
      [{ fileName: 'fotos.zip' }, /separadamente/],
      [{ mimeType: 'image/png', fileName: 'logo.png' }, /Aceitamos/],
    ] as const) {
      assert.throws(
        () => detectFormat(input),
        (error: unknown) => {
          assert.ok(error instanceof KnowledgeError);
          assert.equal(error.code, 'formato_nao_suportado');
          assert.equal(error.retryable, false);
          assert.match(error.message, hint);
          return true;
        },
      );
      assert.equal(isSupportedDocument(input), false);
    }
  });

  it('tamanho: limite com mensagem legível', () => {
    assert.doesNotThrow(() => assertWithinSize(1024));
    assert.throws(
      () => assertWithinSize(DEFAULT_MAX_BYTES + 1),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, 'arquivo_grande');
        assert.match(error.message, /20\.0 MB/);
        return true;
      },
    );
    assert.doesNotThrow(() => assertWithinSize(500, 1000));
    assert.throws(() => assertWithinSize(1500, 1000), /1 KB/);
  });

  it('utilidades', () => {
    assert.equal(extensionOf('a/b/arquivo.Final.PDF'), 'pdf');
    assert.equal(extensionOf('sem-extensao'), '');
    assert.equal(extensionOf(null), '');
    assert.equal(normalizeMimeType('TEXT/HTML; charset=ISO-8859-1'), 'text/html');
    assert.equal(normalizeMimeType(undefined), '');
    assert.equal(formatBytes(900), '900 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  });
});
