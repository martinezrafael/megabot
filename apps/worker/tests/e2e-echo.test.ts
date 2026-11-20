import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  LocalKeyring,
  TokenCipher,
  connectWhatsappNumber,
  prisma,
  withTenant,
} from '@megabot/database';
import { toPgConnectionString } from '@megabot/queue';
import pg from 'pg';
import pino from 'pino';
import { loadWorkerConfig } from '../src/config';
import { startWorker, type RunningWorker } from '../src/worker';
import { cleanupTenants, getEvent, newPhoneNumberId, newTenant, newWaId, run } from './helpers';

/**
 * T1.7 — fluxo completo, com Postgres e fila reais e uma "Meta" de mentira (servidor HTTP local):
 *
 *   evento do webhook (pending) → relay → whatsapp.inbound → decisão → llm.reply (eco)
 *   → whatsapp.outbound → POST na "Meta" com o token DO NÚMERO → wamid gravado
 *   → evento de status (delivered) → relay → whatsapp.status → mensagem `delivered`.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://megabot_app:megabot_pass@localhost:5432/megabot?schema=public';
const KEY = randomBytes(32).toString('base64');
const TOKEN = `EAAG-${run}-token-do-numero-nao-pode-vazar`;
const schema = `pgboss_e2e_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Tempo esgotado: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('E2E eco (T1.7) — worker + Postgres + Meta falsa', () => {
  const metaCalls: Array<{ url: string; authorization?: string; body: Record<string, unknown> }> =
    [];
  const lines: string[] = [];
  let meta: http.Server;
  let worker: RunningWorker;
  let tenantId = '';
  let phoneNumberId = '';
  const waId = newWaId();

  before(async () => {
    meta = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        metaCalls.push({
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: JSON.parse(raw || '{}') as Record<string, unknown>,
        });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            messaging_product: 'whatsapp',
            contacts: [{ input: waId, wa_id: waId }],
            messages: [{ id: `wamid.${run}.eco` }],
          }),
        );
      });
    });
    await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
    const port = (meta.address() as AddressInfo).port;

    const t = await newTenant({ whatsapp: false });
    tenantId = t.tenantId;
    phoneNumberId = newPhoneNumberId();
    const cipher = new TokenCipher(new LocalKeyring({ e2e: Buffer.from(KEY, 'base64') }, 'e2e'));
    await connectWhatsappNumber(
      tenantId,
      { phoneNumberId, wabaId: 'waba-e2e', accessToken: TOKEN },
      cipher,
    );

    const config = loadWorkerConfig({
      NODE_ENV: 'test',
      DATABASE_URL,
      QUEUE_SCHEMA: schema,
      WORKER_POLL_INTERVAL_SECONDS: '0.5',
      WORKER_SHUTDOWN_TIMEOUT_SECONDS: '10',
      WHATSAPP_API_BASE_URL: `http://127.0.0.1:${port}`,
      TOKEN_ENCRYPTION_KEYS: `e2e:${KEY}`,
      WORKER_ECHO_ENABLED: 'true',
      WORKER_INBOX_RELAY_INTERVAL_SECONDS: '0.5',
    });
    const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    worker = await startWorker(config, logger, { relayTenantIds: [tenantId] });
  });

  after(async () => {
    await worker?.stop();
    await new Promise<void>((r) => meta.close(() => r()));
    const pool = new pg.Pool({ connectionString: toPgConnectionString(DATABASE_URL), max: 1 });
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    await cleanupTenants();
    await prisma.$disconnect();
  });

  const addPending = (kind: 'message' | 'status', payload: Record<string, unknown>) =>
    withTenant(tenantId, (tx) =>
      tx.webhookEvent.create({
        data: {
          tenantId,
          phoneNumberId,
          eventKey: `${kind}:${randomUUID()}`,
          kind,
          eventAt: new Date(),
          payload: payload as never,
        },
        select: { id: true },
      }),
    );

  it('mensagem recebida → eco enviado à Meta com o token do número → status delivered', async () => {
    const inbound = await addPending('message', {
      id: `wamid.${run}.in`,
      type: 'text',
      from: waId,
      timestamp: new Date().toISOString(),
      text: 'olá robô',
      profileName: 'Fulana',
    });

    // 1) o eco chegou na "Meta", autenticado com o token do NÚMERO (decifrado do banco).
    const call = await waitFor(() => metaCalls[0], 'chamada na Meta');
    assert.equal(call.url, `/v23.0/${phoneNumberId}/messages`);
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.body.to, waId);
    assert.deepEqual(call.body.text, { body: 'Eco: olá robô', preview_url: false });

    // 2) o evento de entrada foi processado e a mensagem de saída guardou o wamid.
    await waitFor(
      async () => (await getEvent(tenantId, inbound.id)).processStatus === 'processed',
      'evento inbound processado',
    );
    const sent = await waitFor(
      () =>
        withTenant(tenantId, (tx) =>
          tx.message.findFirst({ where: { direction: 'outbound', status: 'sent' } }),
        ),
      'mensagem sent',
    );
    assert.equal(sent.wamid, `wamid.${run}.eco`);
    assert.equal(sent.body, 'Eco: olá robô');

    // 3) status delivered (como a Meta mandaria) → relay → whatsapp.status → delivered.
    await addPending('status', {
      messageId: `wamid.${run}.eco`,
      status: 'delivered',
      timestamp: new Date().toISOString(),
    });
    await waitFor(
      async () =>
        (
          await withTenant(tenantId, (tx) =>
            tx.message.findUniqueOrThrow({ where: { id: sent.id } }),
          )
        ).status === 'delivered',
      'mensagem delivered',
    );
  });

  it('o mesmo evento não gera dois ecos (relay repete, job é deduplicado)', async () => {
    const before = metaCalls.length;
    await addPending('message', {
      id: `wamid.${run}.in2`,
      type: 'text',
      from: waId,
      timestamp: new Date().toISOString(),
      text: 'segunda',
    });
    await waitFor(() => metaCalls.length > before, 'segundo eco');
    await new Promise((r) => setTimeout(r, 2_500)); // várias varreduras do relay
    assert.equal(metaCalls.length, before + 1);
  });

  it('logs: tenant_id nos eventos do fluxo e NENHUM vazamento de token nem de texto', () => {
    const all = lines.join('');
    assert.ok(!all.includes(TOKEN), 'token apareceu nos logs');
    assert.ok(!all.includes('olá robô'), 'texto do cliente apareceu nos logs');
    assert.ok(!all.includes(KEY), 'chave apareceu nos logs');
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const event of [
      'inbox_relay.enqueued',
      'echo.queued',
      'outbound.sent',
      'inbound.decision',
    ]) {
      const found = parsed.filter((l) => l.event === event);
      assert.ok(found.length > 0, `faltou o log ${event}`);
      assert.ok(
        found.every((l) => l.tenant_id === tenantId),
        `${event} sem tenant_id`,
      );
    }
    assert.ok(
      parsed.some((l) => l.metric === 'echo_replies_total' && l.tenant_id === tenantId),
      'faltou a métrica do eco',
    );
  });
});
