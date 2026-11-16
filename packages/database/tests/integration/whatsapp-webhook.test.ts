import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';
import {
  findWhatsappConnectionByPhoneNumberId,
  registerWhatsappConnection,
  storeWebhookEvents,
  type NewWebhookEvent,
} from '../../src/whatsapp';

const run = randomUUID().slice(0, 8);
// Números numéricos e únicos por execução (o phone_number_id é único no sistema).
const PHONE_A = `9${Date.now()}1`;
const PHONE_B = `9${Date.now()}2`;

function event(overrides: Partial<NewWebhookEvent> & { eventKey: string }): NewWebhookEvent {
  return {
    kind: 'message',
    phoneNumberId: PHONE_A,
    eventAt: new Date('2026-11-15T12:00:00Z'),
    payload: { hello: 'world' },
    ...overrides,
  };
}

describe('WhatsApp: conexões e webhook_events (RLS + idempotência)', () => {
  let tenantA = '';
  let tenantB = '';

  before(async () => {
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: 'WA A', slug: `wa-a-${run}` } }),
      prisma.tenant.create({ data: { name: 'WA B', slug: `wa-b-${run}` } }),
    ]);
    tenantA = a.id;
    tenantB = b.id;
    await registerWhatsappConnection(tenantA, { phoneNumberId: PHONE_A, wabaId: 'waba-a' });
    await registerWhatsappConnection(tenantB, { phoneNumberId: PHONE_B, wabaId: 'waba-b' });
  });

  after(async () => {
    // Apaga só o que este teste criou (os eventos e conexões saem em cascata).
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  describe('resolução do tenant por phone_number_id', () => {
    it('encontra o tenant sem precisar saber o tenant antes', async () => {
      assert.deepEqual(await findWhatsappConnectionByPhoneNumberId(PHONE_A), {
        tenantId: tenantA,
        wabaId: 'waba-a',
      });
      assert.deepEqual(await findWhatsappConnectionByPhoneNumberId(PHONE_B), {
        tenantId: tenantB,
        wabaId: 'waba-b',
      });
    });

    it('número desconhecido ou malformado devolve null', async () => {
      assert.equal(await findWhatsappConnectionByPhoneNumberId('1234567890123'), null);
      assert.equal(await findWhatsappConnectionByPhoneNumberId("1'; DROP TABLE tenants;--"), null);
      assert.equal(await findWhatsappConnectionByPhoneNumberId(''), null);
    });

    it('sem contexto nenhum, ninguém enxerga as conexões (a policy de lookup exige o número)', async () => {
      assert.equal((await prisma.whatsappConnection.findMany()).length, 0);
    });

    it('com o contexto de um número, só aquela linha fica visível (não dá para listar todas)', async () => {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.phone_number_id', ${PHONE_A}, true)`;
        return tx.whatsappConnection.findMany();
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.phoneNumberId, PHONE_A);
    });

    it('a policy de lookup é só de leitura: não permite inserir', async () => {
      await assert.rejects(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.phone_number_id', '555000111', true)`;
          await tx.whatsappConnection.create({
            data: { tenantId: tenantA, phoneNumberId: '555000111', wabaId: 'x' },
          });
        }),
      );
    });

    it('um tenant só enxerga as próprias conexões', async () => {
      const rows = await withTenant(tenantA, (tx) => tx.whatsappConnection.findMany());
      assert.deepEqual(
        rows.map((r) => r.phoneNumberId),
        [PHONE_A],
      );
    });

    it('registrar de novo no mesmo tenant atualiza (idempotente)', async () => {
      await registerWhatsappConnection(tenantA, {
        phoneNumberId: PHONE_A,
        wabaId: 'waba-a2',
        displayPhoneNumber: '+55 11 90000-0000',
      });
      assert.equal((await findWhatsappConnectionByPhoneNumberId(PHONE_A))?.wabaId, 'waba-a2');
      await registerWhatsappConnection(tenantA, { phoneNumberId: PHONE_A, wabaId: 'waba-a' });
    });

    it('um número que já é de outro tenant não pode ser registrado por ele', async () => {
      await assert.rejects(
        registerWhatsappConnection(tenantB, { phoneNumberId: PHONE_A, wabaId: 'roubo' }),
      );
      assert.equal((await findWhatsappConnectionByPhoneNumberId(PHONE_A))?.tenantId, tenantA);
    });
  });

  describe('webhook_events', () => {
    it('grava os eventos como pending', async () => {
      const result = await storeWebhookEvents(tenantA, [
        event({ eventKey: `message:wamid.${run}.1`, wamid: `wamid.${run}.1` }),
        event({
          eventKey: `status:wamid.${run}.9:sent`,
          kind: 'status',
          wamid: `wamid.${run}.9`,
          status: 'sent',
        }),
      ]);
      assert.deepEqual(result, { received: 2, inserted: 2, duplicates: 0 });

      const rows = await withTenant(tenantA, (tx) =>
        tx.webhookEvent.findMany({ where: { eventKey: { contains: run } } }),
      );
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.processStatus === 'pending' && r.processedAt === null));
    });

    it('reenvio do mesmo evento é ignorado (chave única por wamid)', async () => {
      const key = `message:wamid.${run}.dup`;
      const first = await storeWebhookEvents(tenantA, [event({ eventKey: key, wamid: key })]);
      const again = await storeWebhookEvents(tenantA, [event({ eventKey: key, wamid: key })]);
      assert.equal(first.inserted, 1);
      assert.deepEqual(again, { received: 1, inserted: 0, duplicates: 1 });

      const rows = await withTenant(tenantA, (tx) =>
        tx.webhookEvent.findMany({ where: { eventKey: key } }),
      );
      assert.equal(rows.length, 1);
    });

    it('duplicado no MESMO lote também é ignorado, sem derrubar o resto', async () => {
      const key = `message:wamid.${run}.lote`;
      const result = await storeWebhookEvents(tenantA, [
        event({ eventKey: key }),
        event({ eventKey: key }),
        event({ eventKey: `${key}.outro` }),
      ]);
      assert.deepEqual(result, { received: 3, inserted: 2, duplicates: 1 });
    });

    it('o mesmo wamid com status diferentes (sent/delivered/read) convive', async () => {
      const wamid = `wamid.${run}.st`;
      const result = await storeWebhookEvents(
        tenantA,
        ['sent', 'delivered', 'read'].map((status) =>
          event({ eventKey: `status:${wamid}:${status}`, kind: 'status', wamid, status }),
        ),
      );
      assert.equal(result.inserted, 3);
    });

    it('eventos fora de ordem ficam ordenáveis pela hora real (event_at)', async () => {
      const wamid = `wamid.${run}.ord`;
      // Chegam: read, sent, delivered. Aconteceram: sent, delivered, read.
      await storeWebhookEvents(tenantA, [
        event({
          eventKey: `status:${wamid}:read`,
          kind: 'status',
          wamid,
          status: 'read',
          eventAt: new Date('2026-11-15T12:00:30Z'),
        }),
      ]);
      await storeWebhookEvents(tenantA, [
        event({
          eventKey: `status:${wamid}:sent`,
          kind: 'status',
          wamid,
          status: 'sent',
          eventAt: new Date('2026-11-15T12:00:00Z'),
        }),
      ]);
      await storeWebhookEvents(tenantA, [
        event({
          eventKey: `status:${wamid}:delivered`,
          kind: 'status',
          wamid,
          status: 'delivered',
          eventAt: new Date('2026-11-15T12:00:10Z'),
        }),
      ]);

      const byEventAt = await withTenant(tenantA, (tx) =>
        tx.webhookEvent.findMany({ where: { wamid }, orderBy: { eventAt: 'asc' } }),
      );
      assert.deepEqual(
        byEventAt.map((r) => r.status),
        ['sent', 'delivered', 'read'],
      );
      const byArrival = await withTenant(tenantA, (tx) =>
        tx.webhookEvent.findMany({ where: { wamid }, orderBy: { receivedAt: 'asc' } }),
      );
      assert.deepEqual(
        byArrival.map((r) => r.status),
        ['read', 'sent', 'delivered'],
      );
    });

    it('a mesma chave em tenants diferentes não conflita', async () => {
      const key = `message:wamid.${run}.shared`;
      const a = await storeWebhookEvents(tenantA, [event({ eventKey: key })]);
      const b = await storeWebhookEvents(tenantB, [
        event({ eventKey: key, phoneNumberId: PHONE_B }),
      ]);
      assert.equal(a.inserted, 1);
      assert.equal(b.inserted, 1);
    });

    it('um tenant nunca enxerga eventos de outro', async () => {
      const key = `message:wamid.${run}.iso`;
      await storeWebhookEvents(tenantA, [event({ eventKey: key })]);
      const seenByB = await withTenant(tenantB, (tx) =>
        tx.webhookEvent.findMany({ where: { eventKey: key } }),
      );
      assert.equal(seenByB.length, 0);
      assert.equal((await prisma.webhookEvent.findMany({ where: { eventKey: key } })).length, 0);
    });

    it('não permite gravar evento em nome de outro tenant', async () => {
      await assert.rejects(
        withTenant(tenantA, (tx) =>
          tx.webhookEvent.create({
            data: {
              tenantId: tenantB,
              phoneNumberId: PHONE_B,
              eventKey: `message:wamid.${run}.fraude`,
              kind: 'message',
              eventAt: new Date(),
              payload: {},
            },
          }),
        ),
      );
    });

    it('o banco recusa kind e process_status inválidos', async () => {
      await assert.rejects(
        storeWebhookEvents(tenantA, [event({ eventKey: `x:${run}`, kind: 'banana' as never })]),
      );
      await assert.rejects(
        withTenant(tenantA, (tx) =>
          tx.webhookEvent.create({
            data: {
              tenantId: tenantA,
              phoneNumberId: PHONE_A,
              eventKey: `y:${run}`,
              kind: 'message',
              eventAt: new Date(),
              payload: {},
              processStatus: 'quase',
            },
          }),
        ),
      );
    });

    it('lista vazia não toca no banco', async () => {
      assert.deepEqual(await storeWebhookEvents(tenantA, []), {
        received: 0,
        inserted: 0,
        duplicates: 0,
      });
    });
  });
});
