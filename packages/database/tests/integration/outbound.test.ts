import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { prisma } from '../../src/client';
import {
  findTenantWhatsappNumber,
  getOutboundMessageForSend,
  prepareOutboundMessage,
  recordInboundMessage,
  registerWhatsappConnection,
  takeWhatsappSendToken,
} from '../../src';

const run = randomUUID().slice(0, 8);
let seq = 0;
const phoneNumberId = () => `${Date.now()}${String(++seq).padStart(3, '0')}`;
const T0 = new Date('2026-11-18T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('envio: mensagem, número do tenant e rate limit (Postgres real)', () => {
  let a = '';
  let b = '';

  before(async () => {
    const [ta, tb] = await Promise.all([
      prisma.tenant.create({ data: { name: 'O A', slug: `o-a-${run}` } }),
      prisma.tenant.create({ data: { name: 'O B', slug: `o-b-${run}` } }),
    ]);
    a = ta.id;
    b = tb.id;
  });
  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [a, b] } } });
    await prisma.$disconnect();
  });

  describe('getOutboundMessageForSend', () => {
    it('devolve a mensagem de saída com o número do contato; outro tenant não enxerga', async () => {
      const waId = `5511${String(Date.now()).slice(-8)}`;
      const inbound = await recordInboundMessage(
        a,
        { waId, wamid: `wamid.${run}.in`, type: 'text', body: 'oi', sentAt: T0 },
        { now: T0 },
      );
      const out = await prepareOutboundMessage(
        a,
        { contactId: inbound.contactId, sender: 'bot', type: 'text', body: 'olá' },
        { now: at(1000) },
      );
      const found = await getOutboundMessageForSend(a, out.id);
      assert.equal(found?.waId, waId);
      assert.equal(found?.body, 'olá');
      assert.equal(found?.status, 'queued');
      assert.equal(found?.wamid, null);
      assert.equal(found?.type, 'text');

      assert.equal(await getOutboundMessageForSend(b, out.id), null); // RLS
      // mensagem RECEBIDA não é de saída
      assert.equal(await getOutboundMessageForSend(a, inbound.messageId), null);
    });
  });

  describe('findTenantWhatsappNumber', () => {
    it('null sem conexão; com duas, vale a mais antiga', async () => {
      assert.equal(await findTenantWhatsappNumber(b), null);
      const first = phoneNumberId();
      const second = phoneNumberId();
      await registerWhatsappConnection(b, { phoneNumberId: first, wabaId: 'w1' });
      await new Promise((r) => setTimeout(r, 15));
      await registerWhatsappConnection(b, { phoneNumberId: second, wabaId: 'w2' });
      assert.deepEqual(await findTenantWhatsappNumber(b), { phoneNumberId: first, wabaId: 'w1' });
    });
  });

  describe('takeWhatsappSendToken (balde de fichas)', () => {
    it('rajada = tamanho do balde; depois diz quanto esperar; as fichas voltam com o tempo', async () => {
      const num = phoneNumberId();
      const opts = { ratePerSecond: 2, burst: 3 };
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await takeWhatsappSendToken(a, num, { ...opts, now: T0 }), {
          allowed: true,
        });
      }
      const denied = await takeWhatsappSendToken(a, num, { ...opts, now: T0 });
      assert.deepEqual(denied, { allowed: false, retryAfterMs: 500 }); // 2 fichas/s → 0,5 s por ficha

      // 250 ms depois: falta metade de uma ficha
      const half = await takeWhatsappSendToken(a, num, { ...opts, now: at(250) });
      assert.deepEqual(half, { allowed: false, retryAfterMs: 250 });

      // 500 ms depois: uma ficha
      assert.deepEqual(await takeWhatsappSendToken(a, num, { ...opts, now: at(500) }), {
        allowed: true,
      });
      assert.equal((await takeWhatsappSendToken(a, num, { ...opts, now: at(500) })).allowed, false);
    });

    it('o balde não passa do tamanho máximo, mesmo depois de muito tempo parado', async () => {
      const num = phoneNumberId();
      const opts = { ratePerSecond: 10, burst: 2 };
      await takeWhatsappSendToken(a, num, { ...opts, now: T0 });
      const later = at(60 * 60 * 1000); // 1 hora depois
      assert.equal((await takeWhatsappSendToken(a, num, { ...opts, now: later })).allowed, true);
      assert.equal((await takeWhatsappSendToken(a, num, { ...opts, now: later })).allowed, true);
      assert.equal((await takeWhatsappSendToken(a, num, { ...opts, now: later })).allowed, false);
    });

    it('cada número tem o seu balde', async () => {
      const n1 = phoneNumberId();
      const n2 = phoneNumberId();
      const opts = { ratePerSecond: 1, burst: 1, now: T0 };
      assert.equal((await takeWhatsappSendToken(a, n1, opts)).allowed, true);
      assert.equal((await takeWhatsappSendToken(a, n1, opts)).allowed, false);
      assert.equal((await takeWhatsappSendToken(a, n2, opts)).allowed, true);
    });

    it('concorrência: 30 pedidos ao mesmo tempo, balde de 5 → exatamente 5 passam', async () => {
      const num = phoneNumberId();
      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          takeWhatsappSendToken(a, num, { ratePerSecond: 1, burst: 5, now: T0 }),
        ),
      );
      assert.equal(results.filter((r) => r.allowed).length, 5);
    });

    it('relógio atrasado (outro servidor) não devolve fichas nem quebra', async () => {
      const num = phoneNumberId();
      const opts = { ratePerSecond: 1, burst: 1 };
      assert.equal((await takeWhatsappSendToken(a, num, { ...opts, now: at(5000) })).allowed, true);
      const back = await takeWhatsappSendToken(a, num, { ...opts, now: T0 });
      assert.equal(back.allowed, false);
      assert.ok(!back.allowed && back.retryAfterMs >= 1 && back.retryAfterMs <= 1000);
    });

    it('parâmetros inválidos são recusados', async () => {
      await assert.rejects(
        () => takeWhatsappSendToken(a, '1', { ratePerSecond: 0 }),
        /ratePerSecond/,
      );
      await assert.rejects(
        () => takeWhatsappSendToken(a, '1', { ratePerSecond: 1, burst: 0.5 }),
        /burst/,
      );
    });

    it('RLS: outro tenant não consegue gastar o balde de um número alheio', async () => {
      const num = phoneNumberId();
      const opts = { ratePerSecond: 1, burst: 2, now: T0 };
      await takeWhatsappSendToken(a, num, opts); // sobra 1 ficha no balde de A
      // B tenta usar o mesmo número: a policy recusa o UPDATE da linha de A.
      await assert.rejects(() => takeWhatsappSendToken(b, num, opts));
      // E o balde de A continua com a sua ficha.
      assert.equal((await takeWhatsappSendToken(a, num, opts)).allowed, true);
      assert.equal((await takeWhatsappSendToken(a, num, opts)).allowed, false);
    });
  });
});
