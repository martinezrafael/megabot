import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhook } from '@megabot/whatsapp';
import { anonymizeWebhook } from '../scripts/anonymize-webhook';
import { fixtureJson } from './whatsapp-fixtures';

describe('Anonimizador de payloads reais', () => {
  it('remove telefones, nomes e texto, mantendo o formato e as referências', () => {
    const original = fixtureJson('official-text');
    const anon = anonymizeWebhook(original);
    const text = JSON.stringify(anon);

    for (const secret of [
      '16505551234',
      '15550783881',
      'Sheena Nelson',
      'Does it come in another color?',
      'US.13491208655302741918',
      'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
    ]) {
      assert.equal(text.includes(secret), false, `"${secret}" não foi anonimizado`);
    }

    // continua sendo um webhook válido, com o mesmo número de eventos
    const before = parseWebhook(original);
    const after = parseWebhook(anon);
    assert.deepEqual(after.invalid, []);
    assert.equal(after.events.length, before.events.length);
  });

  it('o mesmo valor real vira sempre o mesmo valor falso (referências coerentes)', () => {
    const merged = {
      object: 'whatsapp_business_account',
      entry: [
        ...(fixtureJson('official-text') as { entry: unknown[] }).entry,
        ...(fixtureJson('official-status-delivered') as { entry: unknown[] }).entry,
      ],
    };
    const events = parseWebhook(anonymizeWebhook(merged)).events;
    const message = events.find((e) => e.kind === 'message');
    const status = events.find((e) => e.kind === 'status');
    assert.ok(message && status);
    // o telefone do cliente é o mesmo na mensagem (from) e no status (recipient_id)
    assert.equal(
      message.kind === 'message' && message.from,
      status.kind === 'status' && status.recipientId,
    );
  });

  it('não altera o objeto original', () => {
    const original = fixtureJson('official-text');
    const copy = JSON.stringify(original);
    anonymizeWebhook(original);
    assert.equal(JSON.stringify(original), copy);
  });
});
