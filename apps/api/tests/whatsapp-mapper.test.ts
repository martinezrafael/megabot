import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhook } from '@megabot/whatsapp';
import { groupByPhoneNumber, toNewWebhookEvent } from '../src/whatsapp/webhook-events.mapper';
import { fixtureJson } from './whatsapp-fixtures';

describe('Mapper evento -> webhook_events (chave de idempotência)', () => {
  it('mensagem: chave message:<wamid>, hora real e payload JSON', () => {
    const [event] = parseWebhook(fixtureJson('official-text')).events;
    const row = toNewWebhookEvent(event!);

    assert.equal(row.kind, 'message');
    assert.equal(row.eventKey, `message:${row.wamid}`);
    assert.equal(row.wamid, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=');
    assert.equal(row.phoneNumberId, '106540352242922');
    assert.equal(row.eventAt.toISOString(), new Date(1749416383 * 1000).toISOString());
    // payload é JSON puro (datas viram texto), pronto para o jsonb
    const payload = row.payload as { kind: string; text: string; timestamp: string };
    assert.equal(payload.kind, 'message');
    assert.equal(payload.text, 'Does it come in another color?');
    assert.equal(typeof payload.timestamp, 'string');
  });

  it('status: o status entra na chave (o mesmo wamid recebe sent, delivered e read)', () => {
    const keys = ['status-sent', 'official-status-delivered', 'status-read'].map((name) => {
      const [event] = parseWebhook(fixtureJson(name)).events;
      return toNewWebhookEvent(event!).eventKey;
    });
    assert.equal(new Set(keys).size, 3);
    assert.ok(keys.every((k) => k.startsWith('status:')));
    assert.ok(keys[0]!.endsWith(':sent') && keys[2]!.endsWith(':read'));
  });

  it('o mesmo evento sempre gera a mesma chave (base da deduplicação)', () => {
    const a = toNewWebhookEvent(parseWebhook(fixtureJson('official-text')).events[0]!);
    const b = toNewWebhookEvent(parseWebhook(fixtureJson('official-text')).events[0]!);
    assert.equal(a.eventKey, b.eventKey);
  });

  it('erro de sistema: cada ocorrência é gravada (chave aleatória)', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123' },
                errors: [{ code: 131031, title: 'Account locked' }],
              },
            },
          ],
        },
      ],
    };
    const event = parseWebhook(payload).events[0]!;
    const now = new Date('2026-11-15T10:00:00Z');
    const a = toNewWebhookEvent(event, now);
    const b = toNewWebhookEvent(event, now);
    assert.equal(a.kind, 'error');
    assert.notEqual(a.eventKey, b.eventKey);
    assert.equal(a.eventAt, now);
  });

  it('agrupa por número de WhatsApp', () => {
    const merged = {
      object: 'whatsapp_business_account',
      entry: [
        ...(fixtureJson('official-text') as { entry: unknown[] }).entry,
        ...(fixtureJson('image') as { entry: unknown[] }).entry,
      ],
    };
    const groups = groupByPhoneNumber(parseWebhook(merged).events);
    assert.equal(groups.size, 1);
    assert.equal(groups.get('106540352242922')?.length, 2);
  });
});
