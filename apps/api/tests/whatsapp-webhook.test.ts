import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { prisma, registerWhatsappConnection, withTenant } from '@megabot/database';
import { startTestApp, type TestApp } from './helpers';
import {
  SAMPLE_PHONE_NUMBER_ID,
  fixtureJson,
  realFixtures,
  withPhoneNumberId,
} from './whatsapp-fixtures';

const APP_SECRET = 'segredo-do-app-da-meta-para-testes';
const VERIFY_TOKEN = 'token-de-verificacao-de-teste';

const run = randomUUID().slice(0, 8);
// Números únicos por execução (phone_number_id é único no sistema).
const PHONE_A = `8${Date.now()}1`;
const PHONE_B = `8${Date.now()}2`;
const PHONE_UNKNOWN = `8${Date.now()}9`;

type LogLine = Record<string, unknown> & {
  msg?: string;
  event?: string;
  metric?: string;
  request_id?: string;
  tenant_id?: string;
  level?: number;
  res?: { statusCode?: number };
};

const sign = (body: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('Webhook de entrada do WhatsApp', () => {
  let t: TestApp;
  let tenantA = '';
  let tenantB = '';
  const rawLogs: string[] = [];
  const logs = (): LogLine[] =>
    rawLogs.flatMap((chunk) => chunk.split('\n').filter(Boolean)).map((l) => JSON.parse(l));

  /** Envia o payload assinado, exatamente como a Meta faria. */
  const post = (payload: unknown, options: { signature?: string | null; body?: string } = {}) => {
    const body = options.body ?? JSON.stringify(payload);
    const signature = options.signature === undefined ? sign(body) : options.signature;
    return t.api('/webhooks/whatsapp', {
      method: 'POST',
      rawBody: body,
      headers: signature ? { 'x-hub-signature-256': signature } : {},
    });
  };

  /** Payload dos exemplos, apontando para o número do teste e com wamids únicos desta execução. */
  const sample = (name: string, phoneNumberId = PHONE_A, tag = run) => {
    const text = JSON.stringify(withPhoneNumberId(fixtureJson(name), phoneNumberId)).replaceAll(
      'wamid.',
      `wamid.${tag}.`,
    );
    return JSON.parse(text) as { entry: { changes: { value: Record<string, unknown> }[] }[] };
  };

  const rowsOf = (tenantId: string) =>
    withTenant(tenantId, (tx) => tx.webhookEvent.findMany({ orderBy: { receivedAt: 'asc' } }));

  before(async () => {
    t = await startTestApp({
      config: {
        logLevel: 'info',
        whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
      },
      logStream: { write: (chunk: string) => void rawLogs.push(chunk) },
    });
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: 'Webhook A', slug: `wh-a-${run}` } }),
      prisma.tenant.create({ data: { name: 'Webhook B', slug: `wh-b-${run}` } }),
    ]);
    tenantA = a.id;
    tenantB = b.id;
    await registerWhatsappConnection(tenantA, { phoneNumberId: PHONE_A, wabaId: 'waba-a' });
    await registerWhatsappConnection(tenantB, { phoneNumberId: PHONE_B, wabaId: 'waba-b' });
  });

  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await t.close();
  });

  describe('GET: verificação com o token', () => {
    const verify = (query: Record<string, string>) =>
      t.api(`/webhooks/whatsapp?${new URLSearchParams(query).toString()}`);
    const ok = {
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': '1158201444',
    };

    it('devolve o challenge em texto puro quando o token confere', async () => {
      const res = await verify(ok);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(await res.text(), '1158201444');
    });

    it('recusa token errado, modo errado e parâmetros ausentes (403)', async () => {
      assert.equal((await verify({ ...ok, 'hub.verify_token': 'errado' })).status, 403);
      assert.equal((await verify({ ...ok, 'hub.mode': 'unsubscribe' })).status, 403);
      assert.equal((await verify({ 'hub.mode': 'subscribe' })).status, 403);
      assert.equal((await t.api('/webhooks/whatsapp')).status, 403);
    });

    it('não ecoa challenge com caracteres perigosos', async () => {
      const res = await verify({ ...ok, 'hub.challenge': '<script>alert(1)</script>' });
      assert.equal(res.status, 403);
    });
  });

  describe('POST: autenticidade (X-Hub-Signature-256)', () => {
    it('sem assinatura -> 401 e nada é gravado', async () => {
      const res = await post(sample('official-text'), { signature: null });
      assert.equal(res.status, 401);
      assert.equal((await rowsOf(tenantA)).length, 0);
    });

    it('assinatura de outro segredo, malformada ou de outro corpo -> 401', async () => {
      const payload = sample('official-text');
      const body = JSON.stringify(payload);
      assert.equal((await post(payload, { signature: sign(body, 'outro-segredo') })).status, 401);
      assert.equal((await post(payload, { signature: 'sha256=abc' })).status, 401);
      assert.equal((await post(payload, { signature: sign(`${body} `) })).status, 401);
      assert.equal((await rowsOf(tenantA)).length, 0);
    });

    it('a assinatura vale para os BYTES recebidos (formatação e escapes \\u não quebram)', async () => {
      const payload = sample('official-text', PHONE_A, `${run}-bytes`);
      // JSON "bonito" e com acento escapado: JSON.parse -> JSON.stringify mudaria os bytes.
      const body = JSON.stringify(payload, null, 4).replace('another color', 'another c\\u00f4lor');
      const res = await post(payload, { body });
      assert.equal(res.status, 200);
      const stored = (await rowsOf(tenantA)).find((r) => r.wamid?.includes(`${run}-bytes`));
      assert.equal((stored?.payload as { text?: string }).text, 'Does it come in another côlor?');
    });

    it('sem WHATSAPP_APP_SECRET configurado -> 503', async () => {
      const unconfigured = await startTestApp({
        config: { whatsapp: { appSecret: undefined, verifyToken: undefined } },
      });
      try {
        const res = await unconfigured.api('/webhooks/whatsapp', {
          method: 'POST',
          rawBody: '{}',
          headers: { 'x-hub-signature-256': sign('{}') },
        });
        assert.equal(res.status, 503);
        assert.equal(
          (
            await unconfigured.api(
              '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
            )
          ).status,
          403,
        );
      } finally {
        await unconfigured.close();
      }
    });
  });

  describe('POST: gravação e tenant', () => {
    it('grava a mensagem para o tenant do phone_number_id e responde 200', async () => {
      const tag = `${run}-msg`;
      const res = await post(sample('official-text', PHONE_A, tag));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });

      const rows = (await rowsOf(tenantA)).filter((r) => r.wamid?.includes(tag));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, 'message');
      assert.equal(rows[0]!.processStatus, 'pending');
      assert.equal(rows[0]!.phoneNumberId, PHONE_A);
      // e NÃO aparece para o outro tenant
      assert.equal((await rowsOf(tenantB)).filter((r) => r.wamid?.includes(tag)).length, 0);
    });

    it('reenvio do mesmo webhook não duplica (200 de novo, 1 linha)', async () => {
      const payload = sample('image', PHONE_A, `${run}-dup`);
      assert.equal((await post(payload)).status, 200);
      assert.equal((await post(payload)).status, 200);
      assert.equal((await post(payload)).status, 200);
      assert.equal(
        (await rowsOf(tenantA)).filter((r) => r.wamid?.includes(`${run}-dup`)).length,
        1,
      );
    });

    it('reenvios SIMULTÂNEOS também não duplicam', async () => {
      const payload = sample('official-text', PHONE_A, `${run}-race`);
      const responses = await Promise.all(Array.from({ length: 10 }, () => post(payload)));
      assert.ok(responses.every((r) => r.status === 200));
      assert.equal(
        (await rowsOf(tenantA)).filter((r) => r.wamid?.includes(`${run}-race`)).length,
        1,
      );
    });

    it('eventos fora de ordem: read -> sent -> delivered -> (só depois) a mensagem', async () => {
      const tag = `${run}-ooo`;
      // Os exemplos usam o mesmo wamid para os 3 status, com horas diferentes.
      const withTime = (name: string, seconds: number) => {
        const payload = sample(name, PHONE_A, tag);
        (payload.entry[0]!.changes[0]!.value.statuses as { timestamp: string }[])[0]!.timestamp =
          String(1750263700 + seconds);
        return payload;
      };
      assert.equal((await post(withTime('status-read', 30))).status, 200);
      assert.equal((await post(withTime('status-sent', 0))).status, 200);
      assert.equal((await post(withTime('official-status-delivered', 10))).status, 200);
      assert.equal((await post(sample('official-text', PHONE_A, tag))).status, 200);

      const rows = (await rowsOf(tenantA)).filter((r) => r.wamid?.includes(tag));
      assert.equal(rows.length, 4, 'nenhum evento pode ser perdido por chegar fora de ordem');

      const statuses = rows.filter((r) => r.kind === 'status');
      assert.deepEqual(
        statuses.sort((a, b) => a.eventAt.getTime() - b.eventAt.getTime()).map((r) => r.status),
        ['sent', 'delivered', 'read'],
        'a ordem real vem de event_at, não da ordem de chegada',
      );
      assert.deepEqual(
        rows.map((r) => r.kind),
        ['status', 'status', 'status', 'message'],
        'a ordem de chegada fica registrada em received_at',
      );
    });

    it('dois números (dois tenants) no mesmo lote: cada evento vai para o seu tenant', async () => {
      const tag = `${run}-multi`;
      const a = sample('official-text', PHONE_A, `${tag}-a`);
      const b = sample('image', PHONE_B, `${tag}-b`);
      const merged = { object: 'whatsapp_business_account', entry: [...a.entry, ...b.entry] };
      assert.equal((await post(merged)).status, 200);

      assert.equal((await rowsOf(tenantA)).filter((r) => r.wamid?.includes(`${tag}-a`)).length, 1);
      assert.equal((await rowsOf(tenantA)).filter((r) => r.wamid?.includes(`${tag}-b`)).length, 0);
      assert.equal((await rowsOf(tenantB)).filter((r) => r.wamid?.includes(`${tag}-b`)).length, 1);
      assert.equal((await rowsOf(tenantB)).filter((r) => r.wamid?.includes(`${tag}-a`)).length, 0);
    });

    it('número sem tenant: responde 200 (a Meta não deve reenviar) e não grava nada', async () => {
      const before = (
        await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM webhook_events`
      )[0]!.n;
      const res = await post(sample('official-text', PHONE_UNKNOWN, `${run}-unk`));
      assert.equal(res.status, 200);
      const after = (
        await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM webhook_events`
      )[0]!.n;
      assert.equal(after, before);
      const warn = logs().find((l) => l.event === 'whatsapp.webhook.unknown_number');
      assert.equal(warn?.phone_number_id, PHONE_UNKNOWN);
    });

    it('item inválido no lote não derruba os válidos', async () => {
      const tag = `${run}-inv`;
      const payload = sample('official-text', PHONE_A, tag);
      const value = payload.entry[0]!.changes[0]!.value;
      (value.messages as unknown[]).push({ id: `wamid.${tag}.bad`, type: 'text' }); // sem from/timestamp/text
      assert.equal((await post(payload)).status, 200);
      const rows = (await rowsOf(tenantA)).filter((r) => r.wamid?.includes(tag));
      assert.equal(rows.length, 1);
    });
  });

  describe('POST: corpo inválido', () => {
    it('assinatura válida mas JSON quebrado -> 400', async () => {
      const res = await post(null, { body: '{"object":' });
      assert.equal(res.status, 400);
    });

    it('assinatura válida mas não é um webhook do WhatsApp -> 400', async () => {
      assert.equal((await post({ object: 'page', entry: [] })).status, 400);
      assert.equal((await post(null, { body: '' })).status, 400);
    });

    it('corpo acima de 3 MB -> 413 antes de qualquer conta de assinatura', async () => {
      const body = JSON.stringify({ lixo: 'a'.repeat(3 * 1024 * 1024 + 1024) });
      const res = await post(null, { body });
      assert.equal(res.status, 413);
    });
  });

  describe('Sem rate limit por IP', () => {
    it('rajada de webhooks não leva 429 (a assinatura é a proteção)', async () => {
      const limited = await startTestApp({
        config: {
          rateLimit: { windowMs: 60_000, max: 2, authMax: 2 },
          whatsapp: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
        },
      });
      try {
        const body = '{}';
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
          const res = await limited.api('/webhooks/whatsapp', {
            method: 'POST',
            rawBody: body,
            headers: { 'x-hub-signature-256': sign(body) },
          });
          statuses.push(res.status);
        }
        assert.ok(
          statuses.every((s) => s === 400),
          `esperado só 400 (corpo vazio), veio ${statuses}`,
        );
      } finally {
        await limited.close();
      }
    });
  });

  describe('Logs e métricas com tenant_id', () => {
    it('o log da requisição traz request_id e tenant_id; há log de gravação e métricas por tenant', async () => {
      const res = await post(sample('official-text', PHONE_A, `${run}-log`));
      assert.equal(res.status, 200);
      const requestId = res.headers.get('x-request-id');
      assert.ok(requestId);

      const all = logs().filter((l) => l.request_id === requestId);
      const completed = all.find((l) => l.msg === 'request completed');
      assert.equal(completed?.tenant_id, tenantA);
      assert.equal(completed?.res?.statusCode, 200);

      const stored = all.find((l) => l.event === 'whatsapp.webhook.stored');
      assert.equal(stored?.tenant_id, tenantA);
      assert.equal(stored?.inserted, 1);

      const metrics = all.filter((l) => l.event === 'metric');
      const storedMetric = metrics.find((m) => m.metric === 'whatsapp_webhook_events_stored_total');
      assert.equal(storedMetric?.tenant_id, tenantA);
      assert.equal(storedMetric?.value, 1);
      assert.ok(
        metrics.some((m) => m.metric === 'whatsapp_webhook_requests_total' && m.outcome === 'ok'),
      );
      assert.ok(metrics.some((m) => m.metric === 'whatsapp_webhook_duration_ms'));
    });

    it('duplicado gera métrica de duplicidade', async () => {
      const payload = sample('image', PHONE_A, `${run}-logdup`);
      await post(payload);
      const res = await post(payload);
      const requestId = res.headers.get('x-request-id');
      const dup = logs().find(
        (l) => l.request_id === requestId && l.metric === 'whatsapp_webhook_events_duplicate_total',
      );
      assert.equal(dup?.tenant_id, tenantA);
      assert.equal(dup?.value, 1);
    });

    it('assinatura inválida é logada como warn, sem conteúdo da mensagem e sem tenant', async () => {
      const res = await post(sample('official-text'), { signature: sign('x') });
      assert.equal(res.status, 401);
      const requestId = res.headers.get('x-request-id');
      const line = logs().find(
        (l) => l.request_id === requestId && l.event === 'whatsapp.webhook.invalid_signature',
      );
      assert.equal(line?.level, 40);
      assert.equal(line?.tenant_id, undefined);
    });

    it('nenhum log contém o texto das mensagens, telefones completos ou o segredo', () => {
      const text = rawLogs.join('');
      assert.equal(text.includes('another color'), false);
      assert.equal(text.includes('16505551234'), false);
      assert.equal(text.includes(APP_SECRET), false);
      assert.equal(text.includes(VERIFY_TOKEN), false);
    });
  });

  describe('Fixtures reais anonimizadas (tests/fixtures/whatsapp/real)', () => {
    const real = realFixtures();
    if (real.length === 0) {
      it(
        'nenhum payload real adicionado ainda (veja tests/fixtures/whatsapp/README.md)',
        { todo: true },
        () => {},
      );
    }
    for (const [index, fixture] of real.entries()) {
      it(`${fixture.name}: 200 e eventos gravados, e reenvio não duplica`, async () => {
        const tag = `${run}-real${index}`;
        const text = JSON.stringify(withPhoneNumberId(fixture.payload, PHONE_A)).replaceAll(
          'wamid.',
          `wamid.${tag}.`,
        );
        const payload = JSON.parse(text);
        assert.equal((await post(payload)).status, 200);
        const stored = (await rowsOf(tenantA)).filter((r) => r.wamid?.includes(tag));
        assert.ok(stored.length > 0, 'nenhum evento gravado');

        assert.equal((await post(payload)).status, 200);
        assert.equal(
          (await rowsOf(tenantA)).filter((r) => r.wamid?.includes(tag)).length,
          stored.length,
        );
      });
    }
  });

  it('exemplo oficial usa o número esperado (guarda contra mudança nas fixtures)', () => {
    const text = JSON.stringify(fixtureJson('official-text'));
    assert.ok(text.includes(SAMPLE_PHONE_NUMBER_ID));
  });
});
