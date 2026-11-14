import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWebhook } from '../src';

/**
 * Gancho para payloads REAIS: cole em tests/fixtures/real/ o JSON capturado do seu número de teste
 * (sem dados pessoais) e este teste passa a exigir que o parser entenda todos, sem itens inválidos.
 */
const dir = join(__dirname, 'fixtures', 'real');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

describe('payloads reais capturados da Meta', () => {
  if (files.length === 0) {
    it(
      'nenhum payload real adicionado ainda (veja tests/fixtures/README.md)',
      { todo: true },
      () => {},
    );
    return;
  }
  for (const file of files) {
    it(`interpreta ${file} sem itens inválidos`, () => {
      const parsed = parseWebhook(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      assert.deepEqual(parsed.invalid, []);
      assert.ok(parsed.events.length + parsed.ignored > 0);
    });
  }
});
