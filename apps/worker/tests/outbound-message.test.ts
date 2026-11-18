import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  WindowClosedError,
  prepareOutboundMessage,
  recordInboundMessage,
  upsertContact,
} from '@megabot/database';
import { NonRetryableError, isRetryable } from '@megabot/queue';
import { WhatsAppApiError, type SendResult } from '@megabot/whatsapp';
import {
  RateLimitedError,
  createOutboundMessageHandler,
  queueOutboundMessage,
  type OutboundClient,
  type OutboundMessageDeps,
} from '../src/handlers/outbound-message';
import {
  T0,
  at,
  cleanupTenants,
  getMessage,
  newTenant,
  newWaId,
  nextSeq,
  run,
  runJob,
} from './helpers';

const TOKEN = 'EAAG-token-super-secreto';

/** Cliente da Meta de mentira: grava as chamadas e devolve o que o teste mandar. */
function fakeClient(
  behavior: () => SendResult | Error = () => ({
    messageId: `wamid.${run}.out.${nextSeq()}`,
    waId: undefined,
    input: undefined,
  }),
) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const respond = async (method: string, input: unknown) => {
    calls.push({ method, input: input as Record<string, unknown> });
    const result = behavior();
    if (result instanceof Error) throw result;
    return result;
  };
  const client: OutboundClient = {
    sendText: (i) => respond('sendText', i),
    sendTemplate: (i) => respond('sendTemplate', i),
    sendMedia: (i) => respond('sendMedia', i),
  };
  return { client, calls };
}

/** Relógio de mentira: `sleep` só adianta o relógio (nada espera de verdade). */
function fakeClock(start: Date) {
  let current = start.getTime();
  const sleeps: number[] = [];
  return {
    now: () => new Date(current),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms: number) => void (current += ms),
    sleeps,
  };
}

function build(
  over: Partial<OutboundMessageDeps> & { client?: OutboundClient } = {},
  now = at(0.1),
) {
  const clock = fakeClock(now);
  const { client, ...rest } = over;
  const fake = client ? { client, calls: [] } : fakeClient();
  const handler = createOutboundMessageHandler({
    accessToken: TOKEN,
    ratePerSecond: 1000,
    rateLimitMaxWaitMs: 5_000,
    now: clock.now,
    sleep: clock.sleep,
    createClient: () => fake.client,
    ...rest,
  });
  return { handler, clock, calls: fake.calls };
}

/** Contato com janela aberta em T0 + mensagem a enviar. */
async function setup(
  options: { type?: string; body?: string | null; content?: object; whatsapp?: boolean } = {},
) {
  const { tenantId, phoneNumberId } = await newTenant({ whatsapp: options.whatsapp });
  const waId = newWaId();
  const inbound = await recordInboundMessage(
    tenantId,
    { waId, wamid: `wamid.${run}.in.${nextSeq()}`, type: 'text', body: 'oi', sentAt: T0 },
    { now: T0 },
  );
  const out = await prepareOutboundMessage(
    tenantId,
    {
      contactId: inbound.contactId,
      sender: 'bot',
      type: options.type ?? 'text',
      body: options.body === undefined ? 'Olá! Como posso ajudar?' : options.body,
      ...(options.content ? { content: options.content as never } : {}),
      ...(options.type === 'template' ? { kind: 'template' as const } : {}),
    },
    { now: at(0.05) },
  );
  return { tenantId, phoneNumberId, waId, contactId: inbound.contactId, out };
}

const job = (tenantId: string, outboundMessageId: string) => ({ tenantId, outboundMessageId });

describe('job whatsapp.outbound (T1.6) — Postgres real', () => {
  after(cleanupTenants);

  describe('envio', () => {
    it('texto: envia ao número do contato, grava o wamid e marca sent', async () => {
      const s = await setup();
      const h = build();
      await runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id)).promise;

      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0]!.method, 'sendText');
      assert.deepEqual(h.calls[0]!.input, { to: s.waId, body: 'Olá! Como posso ajudar?' });
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.status, 'sent');
      assert.match(row.wamid ?? '', /^wamid\./);
    });

    it('usa o token e o número do tenant ao criar o cliente (e o token nunca vai ao log)', async () => {
      const s = await setup();
      const seen: Array<{ accessToken: string; phoneNumberId: string; tenantId: string }> = [];
      const fake = fakeClient();
      const h = build({
        createClient: (o) => {
          seen.push({
            accessToken: o.accessToken,
            phoneNumberId: o.phoneNumberId,
            tenantId: o.tenantId,
          });
          return fake.client;
        },
      });
      const { promise, logs } = runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id));
      await promise;
      assert.deepEqual(seen, [
        { accessToken: TOKEN, phoneNumberId: s.phoneNumberId!, tenantId: s.tenantId },
      ]);
      const dump = JSON.stringify(logs);
      assert.ok(!dump.includes(TOKEN), 'token vazou no log');
      assert.ok(!dump.includes('Olá! Como posso'), 'texto vazou no log');
      assert.ok(!dump.includes(s.waId), 'número do cliente vazou no log');
    });

    it('imagem por link com legenda; documento com nome de arquivo', async () => {
      const img = await setup({
        type: 'image',
        body: 'Nosso cardápio',
        content: { link: 'https://x.test/a.jpg' },
      });
      const doc = await setup({
        type: 'document',
        body: null,
        content: { id: 'media-1', filename: 'contrato.pdf' },
      });
      const h = build();
      await runJob(h.handler, img.tenantId, job(img.tenantId, img.out.id)).promise;
      await runJob(h.handler, doc.tenantId, job(doc.tenantId, doc.out.id)).promise;
      assert.deepEqual(h.calls[0], {
        method: 'sendMedia',
        input: {
          to: img.waId,
          kind: 'image',
          media: { link: 'https://x.test/a.jpg' },
          caption: 'Nosso cardápio',
        },
      });
      assert.deepEqual(h.calls[1]!.input, {
        to: doc.waId,
        kind: 'document',
        media: { id: 'media-1' },
        filename: 'contrato.pdf',
      });
    });

    it('idempotência: job repetido depois de enviado não reenvia', async () => {
      const s = await setup();
      const h = build();
      await runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id)).promise;
      const second = runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id));
      await second.promise;
      assert.equal(h.calls.length, 1);
      assert.ok(second.logs.some((l) => l.event === 'outbound.skipped'));
    });

    it('mensagem inexistente ou de outro tenant: erro definitivo', async () => {
      const a = await setup();
      const other = await newTenant();
      const h = build();
      await assert.rejects(
        () => runJob(h.handler, other.tenantId, job(other.tenantId, a.out.id)).promise,
        NonRetryableError,
      );
      assert.equal(h.calls.length, 0);
    });
  });

  describe('janela de 24h', () => {
    it('texto livre com a janela fechada NA HORA do envio: bloqueia, marca failed e não chama a Meta', async () => {
      const s = await setup();
      const h = build({}, at(25)); // a mensagem entrou na fila dentro da janela, mas ela fechou
      const { promise, logs } = runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id));
      await assert.rejects(
        promise,
        (e: unknown) => e instanceof WindowClosedError && !isRetryable(e),
      );
      assert.equal(h.calls.length, 0);
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.errorCode, 'window_expired');
      assert.ok(logs.some((l) => l.event === 'outbound.blocked' && l.tenant_id === s.tenantId));
    });

    it('limite exato: nas 24h cravadas já está bloqueado; um instante antes ainda passa', async () => {
      const ok = await setup();
      const blocked = await setup();
      const justBefore = new Date(at(24).getTime() - 1);
      await runJob(build({}, justBefore).handler, ok.tenantId, job(ok.tenantId, ok.out.id)).promise;
      await assert.rejects(
        () =>
          runJob(build({}, at(24)).handler, blocked.tenantId, job(blocked.tenantId, blocked.out.id))
            .promise,
        WindowClosedError,
      );
    });

    it('template é permitido com a janela fechada', async () => {
      const s = await setup({
        type: 'template',
        body: null,
        content: { name: 'boas_vindas', language: 'pt_BR' },
      });
      const h = build({}, at(48));
      await runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id)).promise;
      assert.equal(h.calls[0]!.method, 'sendTemplate');
      assert.deepEqual(h.calls[0]!.input, { to: s.waId, name: 'boas_vindas', language: 'pt_BR' });
      assert.equal((await getMessage(s.tenantId, s.out.id)).status, 'sent');
    });

    it('contato que nunca falou (sem janela): texto bloqueado, template passa', async () => {
      const { tenantId } = await newTenant();
      const contact = await upsertContact(tenantId, { waId: newWaId() });
      await assert.rejects(
        () =>
          prepareOutboundMessage(tenantId, {
            contactId: contact.id,
            sender: 'bot',
            type: 'text',
            body: 'oi',
          }),
        WindowClosedError,
      );
      const tpl = await prepareOutboundMessage(tenantId, {
        contactId: contact.id,
        sender: 'bot',
        type: 'template',
        kind: 'template',
        content: { name: 'retomar', language: 'pt_BR' },
      });
      const h = build();
      await runJob(h.handler, tenantId, job(tenantId, tpl.id)).promise;
      assert.equal(h.calls.length, 1);
    });
  });

  describe('falhas definitivas (não repetem; mensagem vira failed)', () => {
    it('tenant sem número do WhatsApp', async () => {
      const s = await setup({ whatsapp: false });
      const h = build();
      await assert.rejects(
        () => runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id)).promise,
        (e: unknown) => !isRetryable(e),
      );
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.errorCode, 'no_whatsapp_number');
      assert.equal(h.calls.length, 0);
    });

    it('conteúdo inválido (texto sem corpo; template sem nome; tipo desconhecido)', async () => {
      const cases = [
        await setup({ body: null }),
        await setup({ type: 'template', body: null, content: { language: 'pt_BR' } }),
        await setup({ type: 'location', body: null }),
      ];
      const h = build();
      for (const s of cases) {
        await assert.rejects(
          () => runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id)).promise,
          NonRetryableError,
        );
        assert.equal((await getMessage(s.tenantId, s.out.id)).errorCode, 'invalid_message');
      }
      assert.equal(h.calls.length, 0);
    });

    it('erro definitivo da Meta (destinatário inválido, 131026): failed com o código e sem repetir', async () => {
      const s = await setup();
      const err = new WhatsAppApiError({
        httpStatus: 400,
        code: 131026,
        message: 'Message undeliverable',
      });
      const h = build({ client: fakeClient(() => err).client });
      await assert.rejects(
        () =>
          runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id), { attempt: 1, maxAttempts: 9 })
            .promise,
        (e: unknown) => e === err && !isRetryable(e),
      );
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.errorCode, '131026');
    });

    it('token inválido (190): definitivo, categoria auth', async () => {
      const s = await setup();
      const err = new WhatsAppApiError({
        httpStatus: 401,
        code: 190,
        message: 'Invalid OAuth access token',
      });
      const h = build({ client: fakeClient(() => err).client });
      await assert.rejects(
        () => runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id)).promise,
        (e: unknown) => !isRetryable(e),
      );
      assert.equal((await getMessage(s.tenantId, s.out.id)).errorCode, '190');
    });
  });

  describe('falhas transitórias (retry)', () => {
    const transient = () =>
      new WhatsAppApiError({ httpStatus: 503, code: 2, message: 'Service unavailable' });

    it('antes da última tentativa: continua queued e o erro é repetível', async () => {
      const s = await setup();
      const h = build({ client: fakeClient(() => transient()).client });
      const { promise, logs } = runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id), {
        attempt: 2,
        maxAttempts: 9,
      });
      await assert.rejects(promise, (e: unknown) => isRetryable(e));
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.status, 'queued');
      assert.equal(row.errorCode, null);
      assert.ok(
        logs.some(
          (l) => l.event === 'outbound.retry' && l.tenant_id === s.tenantId && l.attempt === 2,
        ),
      );
    });

    it('depois de falhar, a nova tentativa envia e conclui (sem duplicar)', async () => {
      const s = await setup();
      let fail = true;
      const fake = fakeClient(() =>
        fail
          ? transient()
          : { messageId: `wamid.${run}.ok.${nextSeq()}`, waId: undefined, input: undefined },
      );
      const h = build({ client: fake.client });
      await assert.rejects(
        () => runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id), { attempt: 1 }).promise,
      );
      fail = false;
      await runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id), { attempt: 2 }).promise;
      await runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id), { attempt: 3 }).promise; // duplicado: ignorado
      assert.equal(fake.calls.length, 2); // 1 falha + 1 sucesso
      assert.equal((await getMessage(s.tenantId, s.out.id)).status, 'sent');
    });

    it('na última tentativa: desiste e marca failed (não fica queued para sempre)', async () => {
      const s = await setup();
      const h = build({ client: fakeClient(() => transient()).client });
      await assert.rejects(
        () =>
          runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id), { attempt: 9, maxAttempts: 9 })
            .promise,
      );
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.errorCode, '2');
    });

    it('limite da própria Meta (130429) é repetível', async () => {
      const s = await setup();
      const err = new WhatsAppApiError({
        httpStatus: 429,
        code: 130429,
        message: 'Rate limit hit',
      });
      const h = build({ client: fakeClient(() => err).client });
      await assert.rejects(
        () => runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id)).promise,
        (e: unknown) => isRetryable(e),
      );
      assert.equal((await getMessage(s.tenantId, s.out.id)).status, 'queued');
    });
  });

  describe('rate limit por número', () => {
    it('com o balde vazio o job ESPERA a próxima vaga e envia (sem gastar tentativa)', async () => {
      // 2 por segundo: 3 mensagens → a 3ª espera 500 ms
      const { tenantId } = await newTenant();
      const contactIds: string[] = [];
      const outs = [];
      for (let i = 0; i < 3; i++) {
        const inb = await recordInboundMessage(
          tenantId,
          {
            waId: newWaId(),
            wamid: `wamid.${run}.rl.${nextSeq()}`,
            type: 'text',
            body: 'oi',
            sentAt: T0,
          },
          { now: T0 },
        );
        contactIds.push(inb.contactId);
        outs.push(
          await prepareOutboundMessage(
            tenantId,
            { contactId: inb.contactId, sender: 'bot', type: 'text', body: 'x' },
            { now: at(0.05) },
          ),
        );
      }
      const fake = fakeClient();
      const h = build({ ratePerSecond: 2, client: fake.client });
      for (const o of outs) await runJob(h.handler, tenantId, job(tenantId, o.id)).promise;

      assert.equal(fake.calls.length, 3);
      assert.deepEqual(h.clock.sleeps, [500]);
      for (const o of outs) assert.equal((await getMessage(tenantId, o.id)).status, 'sent');
    });

    it('sem vaga dentro do tempo máximo de espera: devolve à fila (repetível) e a mensagem segue queued', async () => {
      const { tenantId } = await newTenant();
      const make = async () => {
        const inb = await recordInboundMessage(
          tenantId,
          {
            waId: newWaId(),
            wamid: `wamid.${run}.rd.${nextSeq()}`,
            type: 'text',
            body: 'oi',
            sentAt: T0,
          },
          { now: T0 },
        );
        return prepareOutboundMessage(
          tenantId,
          { contactId: inb.contactId, sender: 'bot', type: 'text', body: 'x' },
          { now: at(0.05) },
        );
      };
      const [first, second] = [await make(), await make()];
      const fake = fakeClient();
      const h = build({ ratePerSecond: 1, rateLimitMaxWaitMs: 0, client: fake.client });
      await runJob(h.handler, tenantId, job(tenantId, first.id)).promise; // usa a única ficha
      const { promise, logs } = runJob(h.handler, tenantId, job(tenantId, second.id));
      await assert.rejects(
        promise,
        (e: unknown) => e instanceof RateLimitedError && isRetryable(e),
      );
      assert.equal(fake.calls.length, 1);
      assert.equal((await getMessage(tenantId, second.id)).status, 'queued');
      assert.ok(
        logs.some(
          (l) =>
            l.metric === 'outbound_rate_limited_total' &&
            l.result === 'deferred' &&
            l.tenant_id === tenantId,
        ),
      );
    });

    it('cada número tem o seu limite: o outro tenant não é afetado', async () => {
      const x = await setup();
      const y = await setup();
      const fake = fakeClient();
      const h = build({ ratePerSecond: 1, rateLimitMaxWaitMs: 0, client: fake.client });
      await runJob(h.handler, x.tenantId, job(x.tenantId, x.out.id)).promise;
      await runJob(h.handler, y.tenantId, job(y.tenantId, y.out.id)).promise; // outro número: passa
      assert.equal(fake.calls.length, 2);
    });
  });

  describe('com o cliente REAL da Meta e um fetch de mentira', () => {
    const jsonResponse = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    function withFetch(respond: (url: string, init: RequestInit) => Response) {
      const requests: Array<{ url: string; auth: string | null; body: unknown }> = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: String(url),
          auth: headers.get('authorization'),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return respond(String(url), init ?? {});
      }) as typeof fetch;
      return { requests, deps: { fetch: fetchImpl, baseUrl: 'https://meta.test' } };
    }

    // Aqui NÃO passamos `createClient`: o handler usa o WhatsAppClient de verdade.
    const realHandler = (f: ReturnType<typeof withFetch>, now = at(0.1)) => {
      const clock = fakeClock(now);
      return createOutboundMessageHandler({
        accessToken: TOKEN,
        ratePerSecond: 1000,
        rateLimitMaxWaitMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
        ...f.deps,
      });
    };

    it('sucesso: chama o endpoint do número com o token e grava o wamid devolvido', async () => {
      const s = await setup();
      const f = withFetch(() =>
        jsonResponse(200, {
          messages: [{ id: 'wamid.REAL123' }],
          contacts: [{ input: s.waId, wa_id: s.waId }],
        }),
      );
      await runJob(realHandler(f), s.tenantId, job(s.tenantId, s.out.id)).promise;
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]!.url, `https://meta.test/v23.0/${s.phoneNumberId}/messages`);
      assert.equal(f.requests[0]!.auth, `Bearer ${TOKEN}`);
      assert.deepEqual(f.requests[0]!.body, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: s.waId,
        type: 'text',
        text: { body: 'Olá! Como posso ajudar?', preview_url: false },
      });
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.wamid, 'wamid.REAL123');
      assert.equal(row.status, 'sent');
    });

    it('Meta responde 131047 (janela de 24h): definitivo, failed com o código', async () => {
      const s = await setup();
      const f = withFetch(() =>
        jsonResponse(400, {
          error: {
            message: 'Re-engagement message',
            type: 'OAuthException',
            code: 131047,
            fbtrace_id: 'x',
          },
        }),
      );
      await assert.rejects(
        () => runJob(realHandler(f), s.tenantId, job(s.tenantId, s.out.id)).promise,
        (e: unknown) => !isRetryable(e),
      );
      const row = await getMessage(s.tenantId, s.out.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.errorCode, '131047');
    });

    it('Meta responde 500 e erro de rede: repetíveis, mensagem continua queued', async () => {
      const s1 = await setup();
      const f500 = withFetch(() => jsonResponse(500, { error: { message: 'Internal', code: 1 } }));
      await assert.rejects(
        () => runJob(realHandler(f500), s1.tenantId, job(s1.tenantId, s1.out.id)).promise,
        (e: unknown) => isRetryable(e),
      );
      assert.equal((await getMessage(s1.tenantId, s1.out.id)).status, 'queued');

      const s2 = await setup();
      const fNet = withFetch(() => {
        throw new TypeError('fetch failed');
      });
      await assert.rejects(
        () => runJob(realHandler(fNet), s2.tenantId, job(s2.tenantId, s2.out.id)).promise,
        (e: unknown) => isRetryable(e),
      );
      assert.equal((await getMessage(s2.tenantId, s2.out.id)).status, 'queued');
    });
  });

  describe('métricas e logs com tenant_id', () => {
    it('toda linha do job traz tenant_id e não há dado pessoal', async () => {
      const s = await setup();
      const h = build();
      const { promise, logs } = runJob(h.handler, s.tenantId, job(s.tenantId, s.out.id));
      await promise;
      const mine = logs.filter(
        (l) => l.event === 'metric' || String(l.event).startsWith('outbound.'),
      );
      assert.ok(mine.length >= 2);
      for (const l of mine) assert.equal(l.tenant_id, s.tenantId, JSON.stringify(l));
      assert.ok(logs.some((l) => l.metric === 'outbound_messages_total' && l.outcome === 'sent'));
      assert.ok(logs.some((l) => l.event === 'outbound.sent' && l.message_id === s.out.id));
    });
  });

  describe('queueOutboundMessage (quem pede o envio)', () => {
    it('dentro da janela: cria a mensagem queued e enfileira com jobId = id da mensagem', async () => {
      const s = await setup();
      const enqueued: Array<{ payload: unknown; jobId?: string }> = [];
      const rec = await queueOutboundMessage(
        {
          enqueue: async (payload, options) =>
            void enqueued.push({ payload, ...(options.jobId ? { jobId: options.jobId } : {}) }),
          now: () => at(1),
        },
        s.tenantId,
        { contactId: s.contactId, sender: 'agent', type: 'text', body: 'um atendente falando' },
      );
      assert.equal(rec.status, 'queued');
      assert.deepEqual(enqueued, [
        { payload: { tenantId: s.tenantId, outboundMessageId: rec.id }, jobId: rec.id },
      ]);
    });

    it('fora da janela: recusa na hora (WindowClosedError) e NÃO enfileira nem grava', async () => {
      const s = await setup();
      let calls = 0;
      await assert.rejects(
        () =>
          queueOutboundMessage(
            { enqueue: async () => void calls++, now: () => at(30) },
            s.tenantId,
            { contactId: s.contactId, sender: 'bot', type: 'text', body: 'tarde demais' },
          ),
        WindowClosedError,
      );
      assert.equal(calls, 0);
    });

    it('template fora da janela é enfileirado', async () => {
      const s = await setup();
      let calls = 0;
      await queueOutboundMessage(
        { enqueue: async () => void calls++, now: () => at(30) },
        s.tenantId,
        {
          contactId: s.contactId,
          sender: 'bot',
          type: 'template',
          kind: 'template',
          content: { name: 'retomar', language: 'pt_BR' },
        },
      );
      assert.equal(calls, 1);
    });
  });
});
