import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';
import {
  getConversationQuotaPosition,
  getTenantGate,
  getWebhookEvent,
  listPendingWebhookEventIds,
  markWebhookEvent,
  recordInboundMessage,
} from '../../src';

const run = randomUUID().slice(0, 8);
let seq = 0;
const phone = () => `5521${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}`;
const open = (tenantId: string, sentAt: string) =>
  recordInboundMessage(
    tenantId,
    {
      waId: phone(),
      wamid: `wamid.${run}.${++seq}`,
      type: 'text',
      body: 'oi',
      sentAt: new Date(sentAt),
    },
    { now: new Date(sentAt) },
  );

describe('tenant, cota e eventos do webhook (Postgres real)', () => {
  let a = '';
  let b = '';

  before(async () => {
    const [ta, tb] = await Promise.all([
      prisma.tenant.create({
        data: { name: 'Q A', slug: `q-a-${run}`, conversationLimitPerMonth: 3 },
      }),
      prisma.tenant.create({ data: { name: 'Q B', slug: `q-b-${run}`, status: 'suspended' } }),
    ]);
    a = ta.id;
    b = tb.id;
  });
  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [a, b] } } });
    await prisma.$disconnect();
  });

  it('getTenantGate devolve status e limite; tenant inexistente = null', async () => {
    assert.deepEqual(await getTenantGate(a), { status: 'active', conversationLimitPerMonth: 3 });
    assert.deepEqual(await getTenantGate(b), {
      status: 'suspended',
      conversationLimitPerMonth: null,
    });
    assert.equal(await getTenantGate(randomUUID().replace(/^(.{14})./, '$14')), null);
  });

  it('padrão do tenant novo: ativo e sem limite', async () => {
    const t = await prisma.tenant.create({ data: { name: 'Q C', slug: `q-c-${run}` } });
    try {
      assert.deepEqual(await getTenantGate(t.id), {
        status: 'active',
        conversationLimitPerMonth: null,
      });
    } finally {
      await prisma.tenant.delete({ where: { id: t.id } });
    }
  });

  it('CHECKs da migration: status inválido e limite negativo são recusados', async () => {
    await assert.rejects(
      () => prisma.tenant.update({ where: { id: a }, data: { status: 'banido' } }),
      /tenants_status_check/,
    );
    await assert.rejects(
      () => prisma.tenant.update({ where: { id: a }, data: { conversationLimitPerMonth: -1 } }),
      /tenants_conversation_limit_check/,
    );
  });

  it('posição na cota: ordem de abertura dentro do mês; renovar não muda a posição', async () => {
    const c1 = await open(a, '2026-10-05T12:00:00Z');
    const c2 = await open(a, '2026-10-06T12:00:00Z');
    const c3 = await open(a, '2026-10-07T12:00:00Z');
    assert.equal(await getConversationQuotaPosition(a, c1.conversationId), 1);
    assert.equal(await getConversationQuotaPosition(a, c2.conversationId), 2);
    assert.equal(await getConversationQuotaPosition(a, c3.conversationId), 3);
    // Outra conversa depois não muda a posição das anteriores.
    await open(a, '2026-10-08T12:00:00Z');
    assert.equal(await getConversationQuotaPosition(a, c1.conversationId), 1);
  });

  it('meses separados (fuso São Paulo): 01/11 02:59 UTC ainda é outubro; 03:00 UTC já é novembro', async () => {
    const lastOfOct = await open(a, '2026-11-01T02:59:00Z');
    const firstOfNov = await open(a, '2026-11-01T03:00:00Z');
    assert.equal(await getConversationQuotaPosition(a, lastOfOct.conversationId), 5); // 4 de outubro + ela
    assert.equal(await getConversationQuotaPosition(a, firstOfNov.conversationId), 1);
  });

  it('a cota não enxerga conversas de outro tenant', async () => {
    const other = await open(b, '2026-10-05T12:00:00Z');
    assert.equal(await getConversationQuotaPosition(b, other.conversationId), 1);
    // Perguntar pela conversa de B usando o tenant A: não existe (RLS).
    assert.equal(await getConversationQuotaPosition(a, other.conversationId), null);
  });

  it('eventos do webhook: lista pendentes, marca processed e não volta atrás', async () => {
    const mk = (kind: string) =>
      withTenant(a, (tx) =>
        tx.webhookEvent.create({
          data: {
            tenantId: a,
            phoneNumberId: '1',
            eventKey: `${kind}:${randomUUID()}`,
            kind,
            eventAt: new Date(),
            payload: {},
          },
          select: { id: true },
        }),
      ).then((e) => e.id);
    const id = await mk('message');
    assert.ok((await listPendingWebhookEventIds(a)).includes(id));
    assert.equal(await markWebhookEvent(a, id, 'processed'), true);
    assert.equal((await getWebhookEvent(a, id))?.processStatus, 'processed');
    assert.ok(!(await listPendingWebhookEventIds(a)).includes(id));
    // já processado: não muda mais
    assert.equal(await markWebhookEvent(a, id, 'failed'), false);
    assert.equal((await getWebhookEvent(a, id))?.processStatus, 'processed');
    // outro tenant não enxerga nem altera
    assert.equal(await getWebhookEvent(b, id), null);
    assert.equal(await markWebhookEvent(b, id, 'failed'), false);
  });
});
