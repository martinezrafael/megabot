import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  WebhookPayloadError,
  parseWebhook,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  type InboundMessage,
  type StatusUpdate,
} from '../src';
import { captureLogs, captureMetrics, fixture } from './helpers';

function onlyMessage(name: string): InboundMessage {
  const { events, invalid } = parseWebhook(fixture(name));
  assert.deepEqual(invalid, []);
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.kind, 'message');
  return event as InboundMessage;
}

function onlyStatus(name: string): StatusUpdate {
  const { events, invalid } = parseWebhook(fixture(name));
  assert.deepEqual(invalid, []);
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.kind, 'status');
  return event as StatusUpdate;
}

describe('parseWebhook — mensagens recebidas', () => {
  it('texto (exemplo oficial da Meta)', () => {
    const m = onlyMessage('official-text');
    assert.equal(m.type, 'text');
    assert.equal(m.text, 'Does it come in another color?');
    assert.equal(m.from, '16505551234');
    assert.equal(m.profileName, 'Sheena Nelson');
    assert.equal(m.phoneNumberId, '106540352242922');
    assert.equal(m.wabaId, '102290129340398');
    assert.equal(m.id, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=');
    // timestamp vem em segundos (string) e vira Date
    assert.equal(m.timestamp.toISOString(), new Date(1749416383 * 1000).toISOString());
  });

  it('texto com context e referral de anúncio', () => {
    const m = onlyMessage('text-with-context-referral');
    assert.deepEqual(m.context, { messageId: 'wamid.ORIG', from: '15550783881', forwarded: false });
    assert.equal(m.referral?.ctwaClid, 'clid-1');
    assert.equal(m.referral?.sourceType, 'ad');
  });

  it('imagem com legenda', () => {
    const m = onlyMessage('image');
    assert.equal(m.type, 'image');
    assert.deepEqual(m.media, {
      id: '1234567890',
      mimeType: 'image/jpeg',
      sha256: 'abc123',
      caption: 'Segue a foto',
    });
    assert.equal(m.text, 'Segue a foto');
  });

  it('nota de voz', () => {
    const m = onlyMessage('audio-voice');
    assert.equal(m.type, 'audio');
    assert.equal(m.media?.voice, true);
    assert.equal(m.media?.mimeType, 'audio/ogg; codecs=opus');
  });

  it('vídeo, documento e figurinha', () => {
    assert.equal(onlyMessage('video').media?.id, 'VID1');
    const doc = onlyMessage('document');
    assert.equal(doc.media?.filename, 'contrato.pdf');
    assert.equal(doc.media?.caption, 'Contrato');
    const sticker = onlyMessage('sticker');
    assert.equal(sticker.type, 'sticker');
    assert.equal(sticker.media?.animated, false);
  });

  it('localização e contatos', () => {
    assert.deepEqual(onlyMessage('location').location, {
      latitude: -23.55,
      longitude: -46.63,
      name: 'Praça da Sé',
      address: 'São Paulo',
    });
    assert.deepEqual(onlyMessage('contacts').contacts, [
      { name: 'Maria Silva', phones: ['+5511999990000'] },
    ]);
  });

  it('clique em botão de template', () => {
    const m = onlyMessage('button-template-reply');
    assert.equal(m.type, 'button');
    assert.deepEqual(m.button, { text: 'Sim, confirmar', payload: 'CONFIRMAR' });
    assert.equal(m.text, 'Sim, confirmar');
    assert.equal(m.context?.messageId, 'wamid.TPL');
  });

  it('resposta interativa (botão e lista)', () => {
    const button = onlyMessage('interactive-button-reply');
    assert.deepEqual(button.interactive, {
      type: 'button_reply',
      id: 'btn_1',
      title: 'Falar com humano',
    });
    const list = onlyMessage('interactive-list-reply');
    assert.deepEqual(list.interactive, {
      type: 'list_reply',
      id: 'row_2',
      title: 'Segunda via',
      description: 'Boleto',
    });
    assert.equal(list.text, 'Segunda via');
  });

  it('reação', () => {
    assert.deepEqual(onlyMessage('reaction').reaction, { messageId: 'wamid.SENT', emoji: '👍' });
  });

  it('tipo não suportado traz o erro mapeado', () => {
    const m = onlyMessage('unsupported');
    assert.equal(m.type, 'unsupported');
    assert.equal(m.errors?.[0]?.code, 131051);
    assert.equal(m.errors?.[0]?.category, 'invalid_request');
  });

  it('tipo desconhecido não quebra: vira "unknown" com o tipo original', () => {
    const m = onlyMessage('unknown-type-order');
    assert.equal(m.type, 'unknown');
    assert.equal(m.rawType, 'order');
  });
});

describe('parseWebhook — status de envio', () => {
  it('delivered (exemplo oficial da Meta) com conversa e preço', () => {
    const s = onlyStatus('official-status-delivered');
    assert.equal(s.status, 'delivered');
    assert.equal(s.messageId, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MTE5MjVBOTE3MDk5QUVFM0YA');
    assert.equal(s.recipientId, '16505551234');
    assert.equal(s.conversation?.id, '6ceb9d929c9bdc4f90e967a32f8639b4');
    assert.equal(s.conversation?.originType, 'service');
    assert.deepEqual(s.pricing, { billable: true, model: 'CBP', category: 'service' });
  });

  it('sent e read', () => {
    assert.equal(onlyStatus('status-sent').status, 'sent');
    assert.equal(onlyStatus('status-read').status, 'read');
  });

  it('failed por janela de 24h fechada (131047)', () => {
    const s = onlyStatus('status-failed-131047');
    assert.equal(s.status, 'failed');
    assert.equal(s.errors?.[0]?.code, 131047);
    assert.equal(s.errors?.[0]?.category, 'window_expired');
    assert.equal(s.errors?.[0]?.retryable, false);
    assert.match(s.errors?.[0]?.details ?? '', /24 hours/);
  });

  it('failed por mensagem não entregável (131026)', () => {
    const s = onlyStatus('status-failed-131026');
    assert.equal(s.errors?.[0]?.category, 'recipient');
  });
});

describe('parseWebhook — lotes e casos de borda', () => {
  it('um item inválido não derruba o lote', () => {
    const { events, invalid } = parseWebhook(fixture('batch-with-invalid-item'));
    assert.equal(events.length, 3); // texto + imagem + status
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0]!.path, 'entry[0].changes[0].value.messages[1]');
    assert.match(invalid[0]!.reason, /text\.body/);
  });

  it('erro de sistema (value.errors) vira evento "error"', () => {
    const { events } = parseWebhook(fixture('system-error'));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, 'error');
    assert.equal(events[0]!.kind === 'error' && events[0].errors[0]?.category, 'account');
  });

  it('campos que ainda não tratamos são contados em "ignored"', () => {
    const parsed = parseWebhook(fixture('group-field-ignored'));
    assert.equal(parsed.events.length, 0);
    assert.equal(parsed.ignored, 1);
  });

  it('payload que não é da Meta lança WebhookPayloadError', () => {
    assert.throws(() => parseWebhook({ object: 'page', entry: [] }), WebhookPayloadError);
    assert.throws(() => parseWebhook(null), WebhookPayloadError);
    assert.throws(() => parseWebhook('texto'), WebhookPayloadError);
  });

  it('timestamp inválido vai para "invalid"', () => {
    const payload = fixture('official-text') as {
      entry: { changes: { value: { messages: { timestamp: string }[] } }[] }[];
    };
    payload.entry[0]!.changes[0]!.value.messages[0]!.timestamp = 'ontem';
    const { events, invalid } = parseWebhook(payload);
    assert.equal(events.length, 0);
    assert.equal(invalid.length, 1);
  });

  it('emite log e métricas com tenant_id quando informado', () => {
    const { logger, lines } = captureLogs();
    const { metrics, counters } = captureMetrics();
    parseWebhook(fixture('batch-with-invalid-item'), { tenantId: 'tenant-1', logger, metrics });

    const parsedLog = lines.find((l) => l.fields.event === 'whatsapp.webhook.parsed');
    assert.equal(parsedLog?.fields.tenant_id, 'tenant-1');
    assert.deepEqual(parsedLog?.fields.phone_number_ids, ['106540352242922']);
    assert.equal(lines.find((l) => l.fields.event === 'whatsapp.webhook.invalid')?.level, 'warn');
    assert.ok(
      counters.some(
        (c) =>
          c.name === 'whatsapp_webhook_events_total' &&
          c.labels?.tenant_id === 'tenant-1' &&
          c.labels.type === 'text',
      ),
    );
  });

  it('nunca registra o conteúdo das mensagens nos logs', () => {
    const { logger, lines } = captureLogs();
    parseWebhook(fixture('official-text'), { logger });
    assert.equal(JSON.stringify(lines).includes('another color'), false);
  });
});

describe('assinatura e handshake do webhook', () => {
  const secret = 'segredo-do-app';
  const body = JSON.stringify(fixture('official-text'));
  const sign = (b: string, s = secret) =>
    `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

  it('aceita assinatura válida (string e bytes)', () => {
    assert.equal(verifyWebhookSignature(body, sign(body), secret), true);
    assert.equal(verifyWebhookSignature(Buffer.from(body), sign(body), secret), true);
  });

  it('rejeita corpo alterado, segredo errado e cabeçalho ausente/malformado', () => {
    assert.equal(verifyWebhookSignature(body + ' ', sign(body), secret), false);
    assert.equal(verifyWebhookSignature(body, sign(body, 'outro'), secret), false);
    assert.equal(verifyWebhookSignature(body, undefined, secret), false);
    assert.equal(verifyWebhookSignature(body, 'sha256=zzz', secret), false);
    assert.equal(
      verifyWebhookSignature(body, sign(body).replace('sha256=', 'sha1='), secret),
      false,
    );
    assert.equal(verifyWebhookSignature(body, sign(body), ''), false);
  });

  it('handshake devolve o challenge só com modo e token corretos', () => {
    const ok = {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'tok',
      'hub.challenge': '1158201444',
    };
    assert.equal(verifyWebhookChallenge(ok, 'tok'), '1158201444');
    assert.equal(verifyWebhookChallenge({ ...ok, 'hub.verify_token': 'errado' }, 'tok'), null);
    assert.equal(verifyWebhookChallenge({ ...ok, 'hub.mode': 'unsubscribe' }, 'tok'), null);
    assert.equal(verifyWebhookChallenge({ 'hub.mode': 'subscribe' }, 'tok'), null);
    assert.equal(verifyWebhookChallenge(ok, ''), null);
  });
});
