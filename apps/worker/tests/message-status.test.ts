import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { markOutboundSent, prepareOutboundMessage, recordInboundMessage } from '@megabot/database';
import { NonRetryableError, isRetryable } from '@megabot/queue';
import { createMessageStatusHandler } from '../src/handlers/message-status';
import {
  T0,
  addEvent,
  at,
  cleanupTenants,
  getEvent,
  getMessage,
  newTenant,
  newWaId,
  nextSeq,
  run,
  runJob,
} from './helpers';

/** Mensagem enviada (status `sent`, com wamid) pronta para receber eventos de status. */
async function sentMessage() {
  const { tenantId } = await newTenant();
  const inbound = await recordInboundMessage(
    tenantId,
    {
      waId: newWaId(),
      wamid: `wamid.${run}.in.${nextSeq()}`,
      type: 'text',
      body: 'oi',
      sentAt: T0,
    },
    { now: T0 },
  );
  const out = await prepareOutboundMessage(
    tenantId,
    { contactId: inbound.contactId, sender: 'bot', type: 'text', body: 'resposta' },
    { now: at(0.05) },
  );
  const wamid = `wamid.${run}.out.${nextSeq()}`;
  await markOutboundSent(tenantId, out.id, { wamid }, { now: at(0.06) });
  return { tenantId, messageId: out.id, wamid };
}

const statusEvent = (wamid: string, status: string, hours: number, extra: object = {}) => ({
  kind: 'status',
  messageId: wamid,
  status,
  timestamp: at(hours).toISOString(),
  ...extra,
});

const handler = (now = at(1)) => createMessageStatusHandler({ now: () => now });

async function apply(
  tenantId: string,
  payload: Record<string, unknown>,
  now = at(1),
  receivedAt = T0,
) {
  const eventId = await addEvent(tenantId, 'status', payload, receivedAt);
  await runJob(handler(now), tenantId, { tenantId, webhookEventId: eventId }).promise;
  return eventId;
}

describe('job whatsapp.status (T1.6) — Postgres real', () => {
  after(cleanupTenants);

  it('sent → delivered → read: grava cada estado e a hora de entrega e de leitura', async () => {
    const m = await sentMessage();
    await apply(m.tenantId, statusEvent(m.wamid, 'delivered', 0.2));
    let row = await getMessage(m.tenantId, m.messageId);
    assert.equal(row.status, 'delivered');
    assert.equal(row.deliveredAt?.toISOString(), at(0.2).toISOString());

    await apply(m.tenantId, statusEvent(m.wamid, 'read', 0.3));
    row = await getMessage(m.tenantId, m.messageId);
    assert.equal(row.status, 'read');
    assert.equal(row.readAt?.toISOString(), at(0.3).toISOString());
  });

  it('evento "sent" da Meta não faz a mensagem voltar de delivered', async () => {
    const m = await sentMessage();
    await apply(m.tenantId, statusEvent(m.wamid, 'delivered', 0.2));
    await apply(m.tenantId, statusEvent(m.wamid, 'sent', 0.1));
    assert.equal((await getMessage(m.tenantId, m.messageId)).status, 'delivered');
  });

  it('fora de ordem: read chega antes de delivered; delivered depois é ignorado', async () => {
    const m = await sentMessage();
    await apply(m.tenantId, statusEvent(m.wamid, 'read', 0.3));
    await apply(m.tenantId, statusEvent(m.wamid, 'delivered', 0.2));
    assert.equal((await getMessage(m.tenantId, m.messageId)).status, 'read');
  });

  it('o mesmo status duas vezes (evento repetido) não muda nada', async () => {
    const m = await sentMessage();
    const e1 = await apply(m.tenantId, statusEvent(m.wamid, 'delivered', 0.2));
    const before = await getMessage(m.tenantId, m.messageId);
    await apply(m.tenantId, statusEvent(m.wamid, 'delivered', 0.9));
    const after = await getMessage(m.tenantId, m.messageId);
    assert.equal(after.deliveredAt?.toISOString(), before.deliveredAt?.toISOString());
    assert.equal((await getEvent(m.tenantId, e1)).processStatus, 'processed');
  });

  it('failed: grava o código e a mensagem de erro da Meta', async () => {
    const m = await sentMessage();
    await apply(
      m.tenantId,
      statusEvent(m.wamid, 'failed', 0.2, {
        errors: [{ code: 131026, message: 'Message undeliverable' }],
      }),
    );
    const row = await getMessage(m.tenantId, m.messageId);
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCode, '131026');
    assert.equal(row.errorMessage, 'Message undeliverable');
  });

  it('failed depois de delivered é ignorado (entregue não "des-entrega")', async () => {
    const m = await sentMessage();
    await apply(m.tenantId, statusEvent(m.wamid, 'delivered', 0.2));
    await apply(
      m.tenantId,
      statusEvent(m.wamid, 'failed', 0.3, { errors: [{ code: 1, message: 'x' }] }),
    );
    const row = await getMessage(m.tenantId, m.messageId);
    assert.equal(row.status, 'delivered');
    assert.equal(row.errorCode, null);
  });

  it('o evento fica processed e o job repetido é ignorado', async () => {
    const m = await sentMessage();
    const eventId = await apply(m.tenantId, statusEvent(m.wamid, 'delivered', 0.2));
    assert.equal((await getEvent(m.tenantId, eventId)).processStatus, 'processed');
    const again = runJob(handler(), m.tenantId, { tenantId: m.tenantId, webhookEventId: eventId });
    await again.promise;
    assert.ok(again.logs.some((l) => l.outcome === 'already_processed'));
  });

  describe('wamid ainda desconhecido', () => {
    it('evento recente: o job repete (o envio pode não ter gravado o wamid ainda)', async () => {
      const { tenantId } = await newTenant();
      const eventId = await addEvent(
        tenantId,
        'status',
        statusEvent(`wamid.${run}.nada`, 'sent', 0.1),
        T0,
      );
      await assert.rejects(
        () => runJob(handler(at(0.05)), tenantId, { tenantId, webhookEventId: eventId }).promise,
        (e: unknown) => isRetryable(e),
      );
      assert.equal((await getEvent(tenantId, eventId)).processStatus, 'pending');
    });

    it('depois da tolerância (10 min): descarta como processado, sem entupir a DLQ', async () => {
      const { tenantId } = await newTenant();
      const eventId = await addEvent(
        tenantId,
        'status',
        statusEvent(`wamid.${run}.nada2`, 'sent', 0.1),
        T0,
      );
      await runJob(handler(at(1)), tenantId, { tenantId, webhookEventId: eventId }).promise;
      assert.equal((await getEvent(tenantId, eventId)).processStatus, 'processed');
    });

    it('a corrida real: status chega ANTES do wamid ser gravado, e a repetição acerta', async () => {
      const { tenantId } = await newTenant();
      const inbound = await recordInboundMessage(
        tenantId,
        {
          waId: newWaId(),
          wamid: `wamid.${run}.in.${nextSeq()}`,
          type: 'text',
          body: 'oi',
          sentAt: T0,
        },
        { now: T0 },
      );
      const out = await prepareOutboundMessage(
        tenantId,
        { contactId: inbound.contactId, sender: 'bot', type: 'text', body: 'r' },
        { now: at(0.05) },
      );
      const wamid = `wamid.${run}.race.${nextSeq()}`;
      const eventId = await addEvent(
        tenantId,
        'status',
        statusEvent(wamid, 'delivered', 0.1),
        at(0.06),
      );
      const payload = { tenantId, webhookEventId: eventId };

      await assert.rejects(
        () => runJob(handler(at(0.07)), tenantId, payload).promise,
        (e: unknown) => isRetryable(e),
      );

      await markOutboundSent(tenantId, out.id, { wamid }, { now: at(0.08) }); // o envio termina
      await runJob(handler(at(0.09)), tenantId, payload).promise; // retry
      assert.equal((await getMessage(tenantId, out.id)).status, 'delivered');
      assert.equal((await getEvent(tenantId, eventId)).processStatus, 'processed');
    });
  });

  describe('falhas', () => {
    it('payload inválido: erro definitivo (DLQ), evento failed, sem valores do payload na mensagem', async () => {
      const { tenantId } = await newTenant();
      const eventId = await addEvent(tenantId, 'status', {
        kind: 'status',
        messageId: 'segredo123',
        status: 'explodiu',
      });
      await assert.rejects(
        () => runJob(handler(), tenantId, { tenantId, webhookEventId: eventId }).promise,
        (e: unknown) =>
          e instanceof NonRetryableError && !/segredo123|explodiu/.test((e as Error).message),
      );
      assert.equal((await getEvent(tenantId, eventId)).processStatus, 'failed');
    });

    it('evento que não é de status: erro definitivo', async () => {
      const { tenantId } = await newTenant();
      const eventId = await addEvent(tenantId, 'message', { kind: 'message' });
      await assert.rejects(
        () => runJob(handler(), tenantId, { tenantId, webhookEventId: eventId }).promise,
        NonRetryableError,
      );
    });

    it('evento de outro tenant não é visível (RLS): erro definitivo e nada é alterado', async () => {
      const m = await sentMessage();
      const other = await newTenant();
      const eventId = await addEvent(m.tenantId, 'status', statusEvent(m.wamid, 'read', 0.2));
      await assert.rejects(
        () =>
          runJob(handler(), other.tenantId, { tenantId: other.tenantId, webhookEventId: eventId })
            .promise,
        NonRetryableError,
      );
      assert.equal((await getMessage(m.tenantId, m.messageId)).status, 'sent');
      assert.equal((await getEvent(m.tenantId, eventId)).processStatus, 'pending');
    });
  });

  it('logs e métricas com tenant_id ', async () => {
    const m = await sentMessage();
    const eventId = await addEvent(m.tenantId, 'status', statusEvent(m.wamid, 'delivered', 0.2));
    const { promise, logs } = runJob(handler(), m.tenantId, {
      tenantId: m.tenantId,
      webhookEventId: eventId,
    });
    await promise;
    const mine = logs.filter(
      (l) => l.event === 'metric' || String(l.event).startsWith('conversation.'),
    );
    assert.ok(mine.length >= 2);
    for (const l of mine) assert.equal(l.tenant_id, m.tenantId, JSON.stringify(l));
    assert.ok(
      logs.some(
        (l) =>
          l.metric === 'inbound_events_total' && l.kind === 'status' && l.outcome === 'updated',
      ),
    );
  });
});
