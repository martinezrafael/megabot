import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import {
  getWebhookEvent,
  prepareOutboundMessage,
  markOutboundSent,
  prisma,
  recordInboundMessage,
  withTenant,
} from '@megabot/database';
import { NonRetryableError, isRetryable, type JobContext, type QUEUES } from '@megabot/queue';
import {
  INBOUND_METRIC,
  createInboundMessageHandler,
  deterministicUuid,
  type InboundMessageDeps,
} from '../src/handlers/inbound-message';

const run = randomUUID().slice(0, 8);
const T0 = new Date('2026-11-17T12:00:00.000Z');
const H = 60 * 60 * 1000;
const at = (hours: number) => new Date(T0.getTime() + hours * H);

let seq = 0;
const newPhone = () => `5511${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}`;
const tenants: string[] = [];

async function newTenant(data: { status?: string; limit?: number | null } = {}) {
  const t = await prisma.tenant.create({
    data: {
      name: `Inbound ${run}`,
      slug: `inbound-${run}-${++seq}`,
      status: data.status ?? 'active',
      conversationLimitPerMonth: data.limit ?? null,
    },
  });
  tenants.push(t.id);
  return t.id;
}

function messagePayload(over: Record<string, unknown> = {}) {
  return {
    kind: 'message',
    id: `wamid.${run}.${++seq}`,
    type: 'text',
    rawType: 'text',
    from: newPhone(),
    profileName: 'Maria Cliente',
    timestamp: T0.toISOString(),
    text: 'texto secreto do cliente',
    ...over,
  };
}

async function addEvent(
  tenantId: string,
  kind: 'message' | 'status' | 'error',
  payload: Record<string, unknown>,
  receivedAt: Date = T0,
) {
  return withTenant(tenantId, (tx) =>
    tx.webhookEvent.create({
      data: {
        tenantId,
        phoneNumberId: '106540352242922',
        eventKey: `${kind}:${randomUUID()}`,
        kind,
        eventAt: T0,
        receivedAt,
        payload: payload as never,
      },
      select: { id: true },
    }),
  ).then((e) => e.id);
}

type Fields = Record<string, unknown>;

function harness(over: Partial<InboundMessageDeps> = {}, now = at(0.01)) {
  const logs: Fields[] = [];
  const replies: Array<{ payload: unknown; jobId: string }> = [];
  const handler = createInboundMessageHandler({
    enqueueReply: async (payload, { jobId }) => void replies.push({ payload, jobId }),
    now: () => now,
    ...over,
  });
  const execute = (tenantId: string, webhookEventId: string) => {
    const logger = {
      info: (f: Fields) => void logs.push(f),
      warn: (f: Fields) => void logs.push(f),
      error: (f: Fields) => void logs.push(f),
    };
    const ctx: JobContext<typeof QUEUES.whatsappInbound> = {
      jobId: randomUUID(),
      tenantId,
      payload: { tenantId, webhookEventId },
      attempt: 1,
      maxAttempts: 7,
      signal: new AbortController().signal,
      logger: logger as never,
    };
    return handler(ctx);
  };
  const decisions = () => logs.filter((l) => l.event === 'inbound.decision');
  return { execute, logs, replies, decisions };
}

const countMessages = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.message.count({ where: { tenantId } }));
const countConversations = (tenantId: string) =>
  withTenant(tenantId, (tx) => tx.conversation.count({ where: { tenantId } }));

describe('job whatsapp.inbound (T1.5) — Postgres real', () => {
  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  it('mensagem de texto: cria contato, conversa e mensagem, aciona o agente e marca processed', async () => {
    const tenantId = await newTenant();
    const payload = messagePayload();
    const eventId = await addEvent(tenantId, 'message', payload);
    const h = harness();

    await h.execute(tenantId, eventId);

    const contact = await withTenant(tenantId, (tx) =>
      tx.contact.findFirst({ where: { waId: payload.from as string } }),
    );
    assert.ok(contact);
    assert.equal(contact.profileName, 'Maria Cliente');
    const msg = await withTenant(tenantId, (tx) =>
      tx.message.findFirst({ where: { wamid: payload.id as string } }),
    );
    assert.equal(msg?.body, 'texto secreto do cliente');
    assert.equal(msg?.direction, 'inbound');
    assert.equal(await countConversations(tenantId), 1);

    assert.equal(h.replies.length, 1);
    assert.deepEqual(h.replies[0]!.payload, {
      tenantId,
      conversationId: msg?.conversationId,
      inboundEventId: eventId,
    });
    assert.equal(h.replies[0]!.jobId, deterministicUuid(`llm.reply:${eventId}`));
    assert.equal(h.decisions()[0]?.reason, 'ok');
    assert.equal((await getWebhookEvent(tenantId, eventId))?.processStatus, 'processed');
  });

  it('idempotência: reprocessar o mesmo evento não duplica mensagem, conversa nem job', async () => {
    const tenantId = await newTenant();
    const eventId = await addEvent(tenantId, 'message', messagePayload());
    const h = harness();

    await h.execute(tenantId, eventId);
    // 1) job repetido depois de concluído: ignorado
    await h.execute(tenantId, eventId);
    assert.equal(h.replies.length, 1);

    // 2) queda no meio (mensagem gravada, evento ainda pending): o retry refaz tudo sem duplicar
    await withTenant(tenantId, (tx) =>
      tx.webhookEvent.update({ where: { id: eventId }, data: { processStatus: 'pending' } }),
    );
    await h.execute(tenantId, eventId);

    assert.equal(await countMessages(tenantId), 1);
    assert.equal(await countConversations(tenantId), 1);
    assert.equal(h.replies.length, 2);
    assert.equal(h.replies[1]!.jobId, h.replies[0]!.jobId); // o pg-boss descarta o repetido
    assert.equal(h.decisions()[1]?.duplicate, true);
  });

  it('mesma mensagem (wamid) em dois eventos diferentes: uma mensagem só, janela não renova', async () => {
    const tenantId = await newTenant();
    const payload = messagePayload();
    const e1 = await addEvent(tenantId, 'message', payload);
    const e2 = await addEvent(tenantId, 'message', payload);
    const h = harness();
    await h.execute(tenantId, e1);
    await h.execute(tenantId, e2);
    assert.equal(await countMessages(tenantId), 1);
    assert.equal(h.decisions()[1]?.window, 'duplicate');
  });

  it('segunda mensagem do mesmo contato renova a MESMA conversa', async () => {
    const tenantId = await newTenant();
    const from = newPhone();
    const h = harness({}, at(2));
    await h.execute(tenantId, await addEvent(tenantId, 'message', messagePayload({ from })));
    await h.execute(
      tenantId,
      await addEvent(tenantId, 'message', messagePayload({ from, timestamp: at(1).toISOString() })),
    );
    assert.equal(await countConversations(tenantId), 1);
    assert.equal(h.decisions()[1]?.window, 'renewed');
    assert.equal(h.replies.length, 2);
  });

  describe('decisão de acionar o agente', () => {
    it('tenant suspenso: grava a mensagem mas NÃO aciona o agente', async () => {
      const tenantId = await newTenant({ status: 'suspended' });
      const h = harness();
      await h.execute(tenantId, await addEvent(tenantId, 'message', messagePayload()));
      assert.equal(await countMessages(tenantId), 1);
      assert.equal(h.replies.length, 0);
      assert.equal(h.decisions()[0]?.reason, 'tenant_inactive');
    });

    it('cota: conversa nova além do limite é bloqueada; conversa já aberta continua sendo atendida', async () => {
      const tenantId = await newTenant({ limit: 1 });
      const first = newPhone();
      const h = harness({}, at(3));

      await h.execute(
        tenantId,
        await addEvent(tenantId, 'message', messagePayload({ from: first })),
      );
      assert.equal(h.decisions()[0]?.reason, 'ok');

      // contato novo, 2ª conversa do mês: acima do limite (1)
      await h.execute(
        tenantId,
        await addEvent(tenantId, 'message', messagePayload({ timestamp: at(1).toISOString() })),
      );
      assert.equal(h.decisions()[1]?.reason, 'quota_exceeded');
      assert.equal(h.decisions()[1]?.quota_position, 2);

      // o 1º contato escreve de novo (mesma conversa): segue atendido
      await h.execute(
        tenantId,
        await addEvent(
          tenantId,
          'message',
          messagePayload({ from: first, timestamp: at(2).toISOString() }),
        ),
      );
      assert.equal(h.decisions()[2]?.reason, 'ok');
      assert.equal(h.replies.length, 2);
      assert.equal(await countConversations(tenantId), 2);
    });

    it('limite 0 bloqueia tudo; sem limite (null) nunca bloqueia', async () => {
      const zero = await newTenant({ limit: 0 });
      const free = await newTenant({ limit: null });
      const h = harness();
      await h.execute(zero, await addEvent(zero, 'message', messagePayload()));
      await h.execute(free, await addEvent(free, 'message', messagePayload()));
      assert.equal(h.decisions()[0]?.reason, 'quota_exceeded');
      assert.equal(h.decisions()[1]?.reason, 'ok');
    });

    it('a cota recomeça no mês seguinte (fuso de São Paulo)', async () => {
      const tenantId = await newTenant({ limit: 1 });
      // 30/11 às 23:30 em São Paulo (= 01/12 02:30 UTC) ainda é novembro lá;
      // 01/12 12:00 UTC (09:00 em São Paulo) já é dezembro.
      const h = harness({}, new Date('2026-12-01T03:00:00.000Z'));
      await h.execute(
        tenantId,
        await addEvent(
          tenantId,
          'message',
          messagePayload({ timestamp: '2026-12-01T02:30:00.000Z' }),
        ),
      );
      const h2 = harness({}, new Date('2026-12-01T13:00:00.000Z'));
      await h2.execute(
        tenantId,
        await addEvent(
          tenantId,
          'message',
          messagePayload({ timestamp: '2026-12-01T12:00:00.000Z' }),
        ),
      );
      assert.equal(h.decisions()[0]?.quota_position, 1); // novembro
      assert.equal(h2.decisions()[0]?.quota_position, 1); // dezembro: contador novo
      assert.equal(h.replies.length + h2.replies.length, 2);
    });

    it('mensagem atrasada (janela já vencida): grava, mas não aciona o agente', async () => {
      const tenantId = await newTenant();
      const h = harness({}, at(30)); // 30h depois da mensagem
      await h.execute(tenantId, await addEvent(tenantId, 'message', messagePayload()));
      assert.equal(await countMessages(tenantId), 1);
      assert.equal(h.replies.length, 0);
      assert.equal(h.decisions()[0]?.reason, 'window_expired');
    });

    it('tipos que o agente ainda não trata (imagem, reação): grava e não aciona', async () => {
      const tenantId = await newTenant();
      const h = harness();
      await h.execute(
        tenantId,
        await addEvent(
          tenantId,
          'message',
          messagePayload({
            type: 'image',
            rawType: 'image',
            text: undefined,
            media: { id: 'm1', mimeType: 'image/jpeg', caption: 'foto' },
          }),
        ),
      );
      await h.execute(
        tenantId,
        await addEvent(
          tenantId,
          'message',
          messagePayload({
            type: 'reaction',
            text: undefined,
            reaction: { messageId: 'wamid.x', emoji: '👍' },
          }),
        ),
      );
      assert.equal(await countMessages(tenantId), 2);
      assert.equal(h.replies.length, 0);
      assert.deepEqual(
        h.decisions().map((d) => d.reason),
        ['unsupported_type', 'unsupported_type'],
      );
      const image = await withTenant(tenantId, (tx) =>
        tx.message.findFirst({ where: { type: 'image' } }),
      );
      assert.equal(image?.body, 'foto'); // a legenda vira o corpo
    });

    it('resposta de botão (interactive) aciona o agente com o título como corpo', async () => {
      const tenantId = await newTenant();
      const h = harness();
      await h.execute(
        tenantId,
        await addEvent(
          tenantId,
          'message',
          messagePayload({
            type: 'interactive',
            text: undefined,
            interactive: { type: 'button_reply', id: 'b1', title: 'Quero o plano Pro' },
          }),
        ),
      );
      assert.equal(h.replies.length, 1);
      const msg = await withTenant(tenantId, (tx) =>
        tx.message.findFirst({ where: { type: 'interactive' } }),
      );
      assert.equal(msg?.body, 'Quero o plano Pro');
    });
  });

  describe('eventos de status e erro', () => {
    it('status delivered atualiza a mensagem enviada; repetido é ignorado', async () => {
      const tenantId = await newTenant();
      const from = newPhone();
      const inbound = await recordInboundMessage(
        tenantId,
        { waId: from, wamid: `wamid.${run}.in`, type: 'text', body: 'oi', sentAt: T0 },
        { now: at(0.01) },
      );
      const out = await prepareOutboundMessage(
        tenantId,
        { contactId: inbound.contactId, sender: 'bot', type: 'text', body: 'olá' },
        { now: at(0.02) },
      );
      const outWamid = `wamid.${run}.out`;
      await markOutboundSent(tenantId, out.id, { wamid: outWamid }, { now: at(0.03) });

      const h = harness();
      const payload = {
        kind: 'status',
        messageId: outWamid,
        status: 'delivered',
        timestamp: at(0.04).toISOString(),
      };
      await h.execute(tenantId, await addEvent(tenantId, 'status', payload));
      await h.execute(tenantId, await addEvent(tenantId, 'status', payload));

      const row = await withTenant(tenantId, (tx) =>
        tx.message.findUnique({ where: { id: out.id } }),
      );
      assert.equal(row?.status, 'delivered');
      assert.equal(h.replies.length, 0);
    });

    it('status de wamid desconhecido: repete enquanto é recente e desiste depois', async () => {
      const tenantId = await newTenant();
      const payload = {
        kind: 'status',
        messageId: `wamid.${run}.nada`,
        status: 'read',
        timestamp: T0.toISOString(),
      };

      const young = harness({}, at(0.05)); // 3 min depois do recebimento
      const youngId = await addEvent(tenantId, 'status', payload, T0);
      await assert.rejects(
        () => young.execute(tenantId, youngId),
        (e: unknown) => isRetryable(e),
      );
      assert.equal((await getWebhookEvent(tenantId, youngId))?.processStatus, 'pending');

      const old = harness({}, at(1)); // 1h depois: desiste sem erro
      await old.execute(tenantId, youngId);
      assert.equal((await getWebhookEvent(tenantId, youngId))?.processStatus, 'processed');
    });

    it('evento de erro do sistema só é registrado e concluído', async () => {
      const tenantId = await newTenant();
      const h = harness();
      const id = await addEvent(tenantId, 'error', { kind: 'error', errors: [] });
      await h.execute(tenantId, id);
      assert.equal((await getWebhookEvent(tenantId, id))?.processStatus, 'processed');
      assert.ok(h.logs.some((l) => l.event === 'inbound.system_error'));
    });
  });

  describe('falhas', () => {
    it('payload inválido: erro definitivo (DLQ) e evento marcado failed', async () => {
      const tenantId = await newTenant();
      const h = harness();
      const id = await addEvent(tenantId, 'message', { kind: 'message', id: 'x', from: 'abc' });
      await assert.rejects(() => h.execute(tenantId, id), NonRetryableError);
      assert.equal((await getWebhookEvent(tenantId, id))?.processStatus, 'failed');
      assert.equal(await countMessages(tenantId), 0);
    });

    it('evento de OUTRO tenant não é visível (RLS): erro definitivo, nada gravado', async () => {
      const a = await newTenant();
      const b = await newTenant();
      const id = await addEvent(a, 'message', messagePayload());
      const h = harness();
      await assert.rejects(() => h.execute(b, id), NonRetryableError);
      assert.equal(await countMessages(a), 0);
      assert.equal(await countMessages(b), 0);
      assert.equal((await getWebhookEvent(a, id))?.processStatus, 'pending');
    });

    it('falha ao enfileirar o llm.reply: erro repetível e o retry conclui sem duplicar', async () => {
      const tenantId = await newTenant();
      const id = await addEvent(tenantId, 'message', messagePayload());
      let fail = true;
      const sent: string[] = [];
      const h = harness({
        enqueueReply: async (_p, { jobId }) => {
          if (fail) throw new Error('fila fora do ar');
          sent.push(jobId);
        },
      });
      await assert.rejects(
        () => h.execute(tenantId, id),
        (e: unknown) => isRetryable(e),
      );
      assert.equal((await getWebhookEvent(tenantId, id))?.processStatus, 'pending');
      fail = false;
      await h.execute(tenantId, id);
      assert.equal(sent.length, 1);
      assert.equal(await countMessages(tenantId), 1);
      assert.equal((await getWebhookEvent(tenantId, id))?.processStatus, 'processed');
    });
  });

  it('logs e métricas carregam tenant_id e NUNCA o texto, o nome ou o número do cliente', async () => {
    const tenantId = await newTenant();
    const payload = messagePayload();
    const h = harness();
    await h.execute(tenantId, await addEvent(tenantId, 'message', payload));

    assert.ok(h.logs.length > 0);
    const decision = h.decisions()[0]!;
    assert.equal(decision.trigger, true);
    const metric = h.logs.find((l) => l.metric === INBOUND_METRIC.decisions);
    assert.equal(metric?.tenant_id, tenantId);
    // Toda linha emitida pelo job e pelos repositórios traz o tenant_id.
    const relevant = h.logs.filter(
      (l) =>
        l.event === 'metric' ||
        String(l.event).startsWith('inbound.') ||
        String(l.event).startsWith('conversation.'),
    );
    assert.ok(relevant.length >= 4);
    for (const line of relevant) assert.equal(line.tenant_id, tenantId, JSON.stringify(line));
    const dump = JSON.stringify(h.logs);
    assert.ok(!dump.includes('texto secreto'), 'texto da mensagem vazou no log');
    assert.ok(!dump.includes('Maria'), 'nome do contato vazou no log');
    assert.ok(!dump.includes(payload.from as string), 'número do contato vazou no log');
    assert.ok(h.logs.some((l) => l.metric === INBOUND_METRIC.events));
  });

  it('deterministicUuid é estável e tem formato de UUID', () => {
    const a = deterministicUuid('llm.reply:abc');
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(a, deterministicUuid('llm.reply:abc'));
    assert.notEqual(a, deterministicUuid('llm.reply:abd'));
  });
});
