import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join(__dirname, 'fixtures', 'whatsapp');

/** Número da empresa nos exemplos da Meta. Os testes o trocam por um número único por execução. */
export const SAMPLE_PHONE_NUMBER_ID = '106540352242922';

export function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
}

/** Fixtures reais (anonimizadas) adicionadas em tests/fixtures/whatsapp/real/. */
export function realFixtures(): { name: string; payload: unknown }[] {
  const dir = path.join(DIR, 'real');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      name: file,
      payload: JSON.parse(readFileSync(path.join(dir, file), 'utf8')),
    }));
}

/** Troca o `phone_number_id` (em qualquer profundidade) para apontar para o número do teste. */
export function withPhoneNumberId<T>(payload: T, phoneNumberId: string): T {
  const text = JSON.stringify(payload);
  const next = text.replace(/"phone_number_id":"[^"]*"/g, `"phone_number_id":"${phoneNumberId}"`);
  return JSON.parse(next) as T;
}
