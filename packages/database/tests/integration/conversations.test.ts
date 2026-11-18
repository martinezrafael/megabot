import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';
import {
  WINDOW_MS,
  WindowClosedError,
  applyStatusUpdate,
  expireDueConversations,
  findContactByWaId,
  findMessageByWamid,
  getContactWindow,
  listContactConversations,
  listConversationMessages,
  markOutboundFailed,
  markOutboundSent,
  prepareOutboundMessage,
  recordInboundMessage,
  upsertContact,
  type ConversationObservability,
  type LogFields,
} from '../../src';

const run = randomUUID().slice(0, 8);
const T0 = new Date('2026-11-17T12:00:00.000Z');
const H = 60 * 60 * 1000;
const at = (hours: number) => new Date(T0.getTime() + hours * H);

let counter = 0;
const wamid = (label = 'm') => `wamid.${run}.${label}.${++counter}`;
// Cada teste usa um número novo: janelas de testes diferentes nunca se misturam.
let phoneSeq = 0;
const newPhone = () => `5511${String(Date.now()).slice(-5)}${String(++phoneSeq).padStart(2, '0')}`;

function recorder() {
  const logs: LogFields[] = [];
  const metrics: Array<{ name: string; labels?: Record<string, string>; value: number }> = [];
  const obs: ConversationObservability = {
    logger: { info: (f) => void logs.push(f), warn: (f) => void logs.push(f) },
    metrics: { increment: (name, labels, value = 1) => void metrics.push({ name, labels, value }) },
  };
  return { logs, metrics, obs };
}

async function inbound(tenantId: string, waId: string, sentAt: Date, now = sentAt, id = wamid()) {
  return recordInboundMessage(
    tenantId,
    { waId, wamid: id, type: 'text', body: 'oi', sentAt },
    { now },
  );
}

describe('Conversas: janela de 24h, mensagens e RLS (Postgres real)', () => {
  let tenantA = '';
  let tenantB = '';

  before(async () => {
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: 'Conv A', slug: `conv-a-${run}` } }),
      prisma.tenant.create({ data: { name: 'Conv B', slug: `conv-b-${run}` } }),
    ]);
    tenantA = a.id;
    tenantB = b.id;
  });

  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  describe('abertura e renovação da janela (ADR 0010)', () => {
    it('primeira mensagem abre a janela: início = mensagem, vencimento = +24h', async () => {
      const phone = newPhone();
      const r = await inbound(tenantA, phone, T0);
      assert.equal(r.window, 'opened');
      assert.equal(r.duplicate, false);
      assert.equal(r.windowExpiresAt.getTime(), T0.getTime() + WINDOW_MS);
      const info = await getContactWindow(tenantA, r.contactId, { now: at(1) });
      assert.equal(info.state, 'active');
      assert.equal(info.canSendFreeform, true);
      assert.equal(info.conversationId, r.conversationId);
    });

    it('nova mensagem renova a MESMA conversa (janela deslizante), sem abrir outra', async () => {
      const phone = newPhone();
      const first = await inbound(tenantA, phone, T0);
      const second = await inbound(tenantA, phone, at(10));
      assert.equal(second.window, 'renewed');
      assert.equal(second.conversationId, first.conversationId);
      assert.equal(second.windowExpiresAt.getTime(), at(10).getTime() + WINDOW_MS);
      const convs = await listContactConversations(tenantA, first.contactId);
      assert.equal(convs.length, 1);
      assert.equal(convs[0]!.lastInboundAt.getTime(), at(10).getTime());
    });

    it('limite exato: 1 ms antes de vencer renova; no instante exato abre outra conversa', async () => {
      const phone = newPhone();
      const first = await inbound(tenantA, phone, T0);
      const justBefore = await inbound(tenantA, phone, new Date(T0.getTime() + WINDOW_MS - 1));
      assert.equal(justBefore.window, 'renewed');
      assert.equal(justBefore.conversationId, first.conversationId);

      const phone2 = newPhone();
      const a = await inbound(tenantA, phone2, T0);
      const exact = await inbound(tenantA, phone2, new Date(T0.getTime() + WINDOW_MS));
      assert.equal(exact.window, 'opened');
      assert.notEqual(exact.conversationId, a.conversationId);
      const convs = await listContactConversations(tenantA, a.contactId);
      assert.deepEqual(
        convs.map((c) => c.status),
        ['open', 'expired'],
        'a nova é aberta e a antiga ficou expirada',
      );
    });

    it('depois de 24h sem mensagem, a próxima abre uma conversa nova (conta como outra para a cota)', async () => {
      const phone = newPhone();
      const first = await inbound(tenantA, phone, T0);
      const next = await inbound(tenantA, phone, at(30));
      assert.equal(next.window, 'opened');
      assert.notEqual(next.conversationId, first.conversationId);
    });

    it('mensagem ENVIADA não renova a janela', async () => {
      const phone = newPhone();
      const first = await inbound(tenantA, phone, T0);
      await prepareOutboundMessage(
        tenantA,
        { contactId: first.contactId, sender: 'bot', type: 'text', body: 'resposta' },
        { now: at(20) },
      );
      const info = await getContactWindow(tenantA, first.contactId, { now: at(20) });
      assert.equal(info.windowExpiresAt?.getTime(), T0.getTime() + WINDOW_MS);
    });
  });

  describe('idempotência (reenvio do webhook)', () => {
    it('o mesmo wamid não duplica a mensagem nem renova a janela', async () => {
      const phone = newPhone();
      const id = wamid('dup');
      const first = await inbound(tenantA, phone, T0, T0, id);
      // Reenvio chega 10h depois, com o MESMO wamid e o mesmo timestamp da Meta.
      const again = await recordInboundMessage(
        tenantA,
        { waId: phone, wamid: id, type: 'text', body: 'oi', sentAt: T0 },
        { now: at(10) },
      );
      assert.equal(again.duplicate, true);
      assert.equal(again.window, 'duplicate');
      assert.equal(again.messageId, first.messageId);
      assert.equal(again.conversationId, first.conversationId);
      assert.equal(again.windowExpiresAt.getTime(), first.windowExpiresAt.getTime());
      const msgs = await listConversationMessages(tenantA, first.conversationId);
      assert.equal(msgs.length, 1);
    });

    it('reenvio com timestamp diferente também é ignorado (vale o wamid)', async () => {
      const phone = newPhone();
      const id = wamid('dup2');
      const first = await inbound(tenantA, phone, T0, T0, id);
      const again = await inbound(tenantA, phone, at(5), at(5), id);
      assert.equal(again.duplicate, true);
      const info = await getContactWindow(tenantA, first.contactId, { now: at(5) });
      assert.equal(info.windowExpiresAt?.getTime(), T0.getTime() + WINDOW_MS);
    });
  });

  describe('eventos fora de ordem', () => {
    it('mensagem mais antiga que chega depois: entra na janela sem encurtar o prazo', async () => {
      const phone = newPhone();
      const late = await inbound(tenantA, phone, at(2), at(2));
      const earlier = await inbound(tenantA, phone, at(0), at(2));
      assert.equal(earlier.window, 'unchanged');
      assert.equal(earlier.conversationId, late.conversationId);
      const [conv] = await listContactConversations(tenantA, late.contactId);
      assert.equal(conv!.windowStartedAt.getTime(), at(0).getTime(), 'início recua');
      assert.equal(
        conv!.windowExpiresAt.getTime(),
        at(2).getTime() + WINDOW_MS,
        'prazo não encurta',
      );
      const msgs = await listConversationMessages(tenantA, late.conversationId);
      assert.deepEqual(
        msgs.map((m) => m.sentAt.getTime()),
        [at(0).getTime(), at(2).getTime()],
        'a linha do tempo sai na ordem real (hora da Meta), não na de chegada',
      );
    });

    it('mensagem atrasada de uma janela já expirada é anexada a ela, sem reabrir nada', async () => {
      const phone = newPhone();
      const old = await inbound(tenantA, phone, at(0), at(0));
      const current = await inbound(tenantA, phone, at(30), at(30)); // abre a 2ª janela
      const lateOld = await inbound(tenantA, phone, at(5), at(31)); // pertence à 1ª janela
      assert.equal(lateOld.window, 'late_attached');
      assert.equal(lateOld.conversationId, old.conversationId);
      assert.notEqual(lateOld.conversationId, current.conversationId);
      const convs = await listContactConversations(tenantA, old.contactId);
      assert.equal(convs.length, 2, 'nenhuma conversa nova (não conta cota)');
    });

    it('mensagem antiga demais sem registro nasce expirada e não conta como janela aberta', async () => {
      const phone = newPhone();
      const r = await inbound(tenantA, phone, at(-48), at(0));
      assert.equal(r.window, 'late_expired');
      const info = await getContactWindow(tenantA, r.contactId, { now: at(0) });
      assert.equal(info.state, 'expired');
      assert.equal(info.canSendFreeform, false);
    });

    it('status fora de ordem: read antes de delivered; delivered depois de read é ignorado', async () => {
      const phone = newPhone();
      const r = await inbound(tenantA, phone, T0);
      const out = await prepareOutboundMessage(
        tenantA,
        { contactId: r.contactId, sender: 'bot', type: 'text', body: 'x' },
        { now: at(1) },
      );
      const id = wamid('out');
      await markOutboundSent(tenantA, out.id, { wamid: id, at: at(1) });
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: id, status: 'read', at: at(3) }),
        'updated',
      );
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: id, status: 'delivered', at: at(2) }),
        'ignored',
      );
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: id, status: 'failed', at: at(4) }),
        'ignored',
      );
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: id, status: 'read', at: at(3) }),
        'ignored',
        'repetido',
      );
      const msg = await findMessageByWamid(tenantA, id);
      assert.equal(msg?.status, 'read');
    });

    it('status de wamid desconhecido devolve not_found (o chamador tenta de novo depois)', async () => {
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: 'wamid.nao-existe', status: 'sent', at: T0 }),
        'not_found',
      );
      // Status de uma mensagem RECEBIDA também não se aplica.
      const phone = newPhone();
      const id = wamid('in');
      await inbound(tenantA, phone, T0, T0, id);
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: id, status: 'read', at: T0 }),
        'not_found',
      );
    });

    it('delivered chegando ANTES de markOutboundSent: o wamid é gravado e o status não regride', async () => {
      const phone = newPhone();
      const r = await inbound(tenantA, phone, T0);
      const out = await prepareOutboundMessage(
        tenantA,
        { contactId: r.contactId, sender: 'bot', type: 'text', body: 'x' },
        { now: at(1) },
      );
      const id = wamid('race');
      // O wamid ainda não está gravado, então o webhook não acha a mensagem...
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: id, status: 'delivered', at: at(1) }),
        'not_found',
      );
      await markOutboundSent(tenantA, out.id, { wamid: id });
      // ...e depois da gravação, o reprocessamento (retry da fila) funciona.
      assert.equal(
        await applyStatusUpdate(tenantA, { wamid: id, status: 'delivered', at: at(1) }),
        'updated',
      );
      await markOutboundSent(tenantA, out.id, { wamid: id }); // repetir é inofensivo
      assert.equal((await findMessageByWamid(tenantA, id))?.status, 'delivered');
    });
  });

  describe('envio: regra da janela (ADR 0010, decisões 4–6)', () => {
    it('envio livre dentro da janela passa; fora dela lança WindowClosedError', async () => {
      const phone = newPhone();
      const r = await inbound(tenantA, phone, T0);
      const ok = await prepareOutboundMessage(
        tenantA,
        { contactId: r.contactId, sender: 'agent', type: 'text', body: 'olá' },
        { now: new Date(T0.getTime() + WINDOW_MS - 1) },
      );
      assert.equal(ok.status, 'queued');
      assert.equal(ok.conversationId, r.conversationId);

      await assert.rejects(
        () =>
          prepareOutboundMessage(
            tenantA,
            { contactId: r.contactId, sender: 'bot', type: 'text', body: 'tarde' },
            { now: new Date(T0.getTime() + WINDOW_MS) },
          ),
        (e: unknown) => {
          assert.ok(e instanceof WindowClosedError);
          assert.equal(e.retryable, false);
          return true;
        },
      );
    });

    it('a janela "open" no banco mas vencida também bloqueia (não depende da varredura)', async () => {
      const phone = newPhone();
      const r = await inbound(tenantA, phone, T0);
      const stored = await prisma.conversation.findFirst({ where: { id: r.conversationId } });
      assert.equal(stored, null, 'sem tenant na sessão o RLS esconde a linha');
      await assert.rejects(
        () =>
          prepareOutboundMessage(
            tenantA,
            { contactId: r.contactId, sender: 'bot', type: 'text', body: 'x' },
            { now: at(25) },
          ),
        WindowClosedError,
      );
    });

    it('contato que nunca falou: envio livre bloqueado; template permitido', async () => {
      const contact = await upsertContact(tenantA, { waId: newPhone() });
      await assert.rejects(
        () =>
          prepareOutboundMessage(
            tenantA,
            { contactId: contact.id, sender: 'bot', type: 'text', body: 'x' },
            { now: T0 },
          ),
        WindowClosedError,
      );
      const tpl = await prepareOutboundMessage(
        tenantA,
        {
          contactId: contact.id,
          sender: 'bot',
          type: 'template',
          content: { name: 'aviso' },
          kind: 'template',
        },
        { now: T0 },
      );
      assert.equal(
        tpl.conversationId,
        null,
        'sem janela, o template não pertence a nenhuma conversa',
      );
    });

    it('falha de envio marca failed e não regride mensagem já entregue', async () => {
      const phone = newPhone();
      const r = await inbound(tenantA, phone, T0);
      const m1 = await prepareOutboundMessage(
        tenantA,
        { contactId: r.contactId, sender: 'bot', type: 'text', body: 'a' },
        { now: at(1) },
      );
      assert.equal(
        await markOutboundFailed(tenantA, m1.id, {
          errorCode: '131047',
          errorMessage: 'x'.repeat(900),
        }),
        true,
      );
      const row = await withTenant(tenantA, (tx) => tx.message.findFirst({ where: { id: m1.id } }));
      assert.equal(row?.status, 'failed');
      assert.equal(row?.errorCode, '131047');
      assert.equal(row?.errorMessage?.length, 500, 'mensagem de erro truncada');
      assert.equal(await markOutboundFailed(tenantA, m1.id, {}), false, 'já falhou: nada a fazer');
    });
  });

  describe('varredura de expiração', () => {
    it('expira só as janelas vencidas e é repetível', async () => {
      const t = await prisma.tenant.create({ data: { name: 'Sweep', slug: `sweep-${run}` } });
      try {
        const oldPhone = newPhone();
        const freshPhone = newPhone();
        const old = await inbound(t.id, oldPhone, at(0), at(0));
        const fresh = await inbound(t.id, freshPhone, at(20), at(20));
        const rec = recorder();
        assert.equal(await expireDueConversations(t.id, { now: at(25), ...rec.obs }), 1);
        assert.equal(await expireDueConversations(t.id, { now: at(25), ...rec.obs }), 0);
        assert.equal(
          (await getContactWindow(t.id, old.contactId, { now: at(25) })).state,
          'expired',
        );
        assert.equal(
          (await getContactWindow(t.id, fresh.contactId, { now: at(25) })).canSendFreeform,
          true,
        );
        const [conv] = await listContactConversations(t.id, old.contactId);
        assert.equal(conv!.status, 'expired');
        assert.equal(
          rec.metrics.filter((m) => m.name === 'conversation_windows_expired_total').length,
          1,
        );
        assert.ok(rec.logs.every((l) => l.tenant_id === t.id));
      } finally {
        await prisma.tenant.delete({ where: { id: t.id } });
      }
    });
  });

  describe('concorrência', () => {
    it('10 mensagens simultâneas do mesmo contato: 1 janela aberta e 10 mensagens', async () => {
      const phone = newPhone();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => inbound(tenantA, phone, at(i * 0.01), at(1))),
      );
      const conversationIds = new Set(results.map((r) => r.conversationId));
      assert.equal(conversationIds.size, 1);
      assert.equal(results.filter((r) => r.window === 'opened').length, 1, 'só uma abre a janela');
      const msgs = await listConversationMessages(tenantA, [...conversationIds][0]!);
      assert.equal(msgs.length, 10);
    });

    it('o mesmo wamid entregue 5x ao mesmo tempo grava uma vez só', async () => {
      const phone = newPhone();
      const id = wamid('burst');
      const results = await Promise.all(
        Array.from({ length: 5 }, () => inbound(tenantA, phone, T0, T0, id)),
      );
      assert.equal(results.filter((r) => !r.duplicate).length, 1);
      const count = await withTenant(tenantA, (tx) => tx.message.count({ where: { wamid: id } }));
      assert.equal(count, 1);
    });

    it('contatos novos simultâneos para o mesmo número: 1 contato só', async () => {
      const phone = newPhone();
      const contacts = await Promise.all(
        Array.from({ length: 6 }, () => upsertContact(tenantA, { waId: phone })),
      );
      assert.equal(new Set(contacts.map((c) => c.id)).size, 1);
    });
  });

  describe('contatos', () => {
    it('nome do perfil só é atualizado quando vem preenchido', async () => {
      const phone = newPhone();
      await upsertContact(tenantA, { waId: phone, profileName: 'Maria' });
      await upsertContact(tenantA, { waId: phone });
      await upsertContact(tenantA, { waId: phone, profileName: null });
      assert.equal((await findContactByWaId(tenantA, phone))?.profileName, 'Maria');
      await upsertContact(tenantA, { waId: phone, profileName: 'Maria Silva' });
      assert.equal((await findContactByWaId(tenantA, phone))?.profileName, 'Maria Silva');
    });

    it('rejeita waId inválido antes de tocar no banco', async () => {
      await assert.rejects(() => upsertContact(tenantA, { waId: '+55 11 99999-0000' }));
      await assert.rejects(() => upsertContact(tenantA, { waId: '123' }));
      await assert.rejects(() =>
        recordInboundMessage(tenantA, { waId: 'abc', wamid: wamid(), type: 'text', sentAt: T0 }),
      );
    });
  });

  describe('RLS e integridade', () => {
    it('o mesmo número em tenants diferentes são contatos diferentes, e um tenant não vê o outro', async () => {
      const phone = newPhone();
      const a = await inbound(tenantA, phone, T0);
      const b = await inbound(tenantB, phone, T0);
      assert.notEqual(a.contactId, b.contactId);
      assert.notEqual(a.conversationId, b.conversationId);

      assert.equal(
        await findMessageByWamid(
          tenantB,
          (await listConversationMessages(tenantA, a.conversationId))[0]!.wamid!,
        ),
        null,
      );
      assert.deepEqual(await listConversationMessages(tenantB, a.conversationId), []);
      assert.deepEqual(await listContactConversations(tenantB, a.contactId), []);
      assert.equal((await getContactWindow(tenantB, a.contactId, { now: at(1) })).state, 'expired');
    });

    it('sem contexto de tenant nada aparece e nada pode ser gravado', async () => {
      assert.equal(await prisma.contact.count(), 0);
      assert.equal(await prisma.conversation.count(), 0);
      assert.equal(await prisma.message.count(), 0);
      await assert.rejects(() =>
        prisma.contact.create({ data: { tenantId: tenantA, waId: newPhone() } }),
      );
    });

    it('tenant B não consegue enviar mensagem para contato do tenant A', async () => {
      const a = await inbound(tenantA, newPhone(), T0);
      await assert.rejects(
        () =>
          prepareOutboundMessage(
            tenantB,
            { contactId: a.contactId, sender: 'bot', type: 'text', body: 'x' },
            { now: at(1) },
          ),
        /Contato não encontrado/,
      );
    });

    it('chave estrangeira composta impede ligar conversa do tenant B a contato do tenant A', async () => {
      const a = await upsertContact(tenantA, { waId: newPhone() });
      await assert.rejects(() =>
        withTenant(tenantB, (tx) =>
          tx.conversation.create({
            data: {
              tenantId: tenantB,
              contactId: a.id,
              windowStartedAt: T0,
              windowExpiresAt: at(24),
              lastInboundAt: T0,
            },
          }),
        ),
      );
    });

    it('banco recusa duas janelas abertas do mesmo contato (índice parcial)', async () => {
      const r = await inbound(tenantA, newPhone(), T0);
      await assert.rejects(
        () =>
          withTenant(tenantA, (tx) =>
            tx.conversation.create({
              data: {
                tenantId: tenantA,
                contactId: r.contactId,
                windowStartedAt: at(1),
                windowExpiresAt: at(25),
                lastInboundAt: at(1),
              },
            }),
          ),
        /conversations_one_open_per_contact_key|Unique constraint/,
      );
    });

    it('CHECKs: status inválido, janela invertida, direção/remetente incoerentes', async () => {
      const r = await inbound(tenantA, newPhone(), T0);
      const base = { tenantId: tenantA, contactId: r.contactId, sentAt: T0 };
      await assert.rejects(() =>
        withTenant(tenantA, (tx) =>
          tx.conversation.create({
            data: {
              tenantId: tenantA,
              contactId: r.contactId,
              status: 'foo',
              windowStartedAt: at(-3),
              windowExpiresAt: at(-2),
              lastInboundAt: at(-3),
              expiredAt: at(-2),
            },
          }),
        ),
      );
      await assert.rejects(() =>
        withTenant(tenantA, (tx) =>
          tx.conversation.create({
            data: {
              tenantId: tenantA,
              contactId: r.contactId,
              status: 'expired',
              windowStartedAt: at(-3),
              windowExpiresAt: at(-4),
              lastInboundAt: at(-3),
              expiredAt: at(-4),
            },
          }),
        ),
      );
      await assert.rejects(() =>
        withTenant(tenantA, (tx) =>
          tx.message.create({
            data: {
              ...base,
              direction: 'inbound',
              sender: 'bot',
              type: 'text',
              status: 'received',
              wamid: wamid(),
              conversationId: r.conversationId,
            },
          }),
        ),
      );
      await assert.rejects(
        () =>
          withTenant(tenantA, (tx) =>
            tx.message.create({
              data: {
                ...base,
                direction: 'inbound',
                sender: 'contact',
                type: 'text',
                status: 'received',
              },
            }),
          ),
        'recebida sem wamid/conversa',
      );
    });

    it('apagar o tenant apaga contatos, conversas e mensagens (cascata)', async () => {
      const t = await prisma.tenant.create({ data: { name: 'Cascade', slug: `casc-${run}` } });
      const phone = newPhone();
      const r = await inbound(t.id, phone, T0);
      await prisma.tenant.delete({ where: { id: t.id } });
      assert.equal(await findContactByWaId(t.id, phone), null);
      assert.deepEqual(await listConversationMessages(t.id, r.conversationId), []);
    });
  });

  describe('logs e métricas com tenant_id', () => {
    it('abrir, renovar, duplicar e bloquear emitem logs/métricas com tenant_id e sem dados pessoais', async () => {
      const rec = recorder();
      const phone = newPhone();
      const id = wamid('obs');
      const opts = { ...rec.obs };
      const first = await recordInboundMessage(
        tenantA,
        {
          waId: phone,
          profileName: 'Fulano Secreto',
          wamid: id,
          type: 'text',
          body: 'texto privado',
          sentAt: T0,
        },
        { now: T0, ...opts },
      );
      await recordInboundMessage(
        tenantA,
        { waId: phone, wamid: wamid(), type: 'text', body: 'outro', sentAt: at(1) },
        { now: at(1), ...opts },
      );
      await recordInboundMessage(
        tenantA,
        { waId: phone, wamid: id, type: 'text', body: 'texto privado', sentAt: T0 },
        { now: at(2), ...opts },
      );
      await assert.rejects(() =>
        prepareOutboundMessage(
          tenantA,
          { contactId: first.contactId, sender: 'bot', type: 'text', body: 'x' },
          { now: at(30), ...opts },
        ),
      );

      const names = rec.metrics.map((m) => `${m.name}:${m.labels?.outcome ?? ''}`);
      assert.ok(names.includes('conversation_windows_opened_total:'));
      assert.ok(names.includes('conversation_windows_renewed_total:'));
      assert.ok(names.includes('conversation_messages_total:created'));
      assert.ok(names.includes('conversation_messages_total:duplicate'));
      assert.ok(names.includes('conversation_outbound_blocked_total:'));
      assert.ok(rec.metrics.every((m) => m.labels?.tenant_id === tenantA));
      assert.ok(rec.logs.every((l) => l.tenant_id === tenantA));

      const dump = JSON.stringify(rec.logs) + JSON.stringify(rec.metrics);
      assert.equal(dump.includes('texto privado'), false);
      assert.equal(dump.includes('Fulano Secreto'), false);
      assert.equal(dump.includes(phone), false);
    });
  });
});
