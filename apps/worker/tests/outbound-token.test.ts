import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import {
  LocalKeyring,
  TokenCipher,
  connectWhatsappNumber,
  getWhatsappAccessToken,
  prepareOutboundMessage,
  recordInboundMessage,
  withTenant,
} from '@megabot/database';
import {
  createOutboundMessageHandler,
  type OutboundClient,
} from '../src/handlers/outbound-message';
import {
  T0,
  at,
  captureLogger,
  cleanupTenants,
  getMessage,
  newPhoneNumberId,
  newTenant,
  newWaId,
  nextSeq,
  run,
  runJob,
} from './helpers';

const cipher = new TokenCipher(new LocalKeyring({ k1: randomBytes(32) }, 'k1'));
const TENANT_TOKEN = `EAAG-${run}-token-do-tenant-nao-vazar`;
const GLOBAL_TOKEN = `EAAG-${run}-token-global-nao-vazar`;

async function setup(withToken: boolean) {
  const { tenantId } = await newTenant({ whatsapp: false });
  const phoneNumberId = newPhoneNumberId();
  if (withToken) {
    await connectWhatsappNumber(
      tenantId,
      { phoneNumberId, wabaId: 'w', accessToken: TENANT_TOKEN },
      cipher,
    );
  } else {
    await withTenant(tenantId, (tx) =>
      tx.whatsappConnection.create({ data: { tenantId, phoneNumberId, wabaId: 'w' } }),
    );
  }
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
    { contactId: inbound.contactId, sender: 'bot', type: 'text', body: 'Olá' },
    { now: at(0.05) },
  );
  return { tenantId, phoneNumberId, out };
}

function build(
  over: Parameters<typeof createOutboundMessageHandler>[0] extends infer D ? Partial<D> : never,
) {
  const created: Array<{ accessToken: string; phoneNumberId: string }> = [];
  const client: OutboundClient = {
    sendText: async () => ({ messageId: `wamid.${run}.o.${nextSeq()}` }) as never,
    sendTemplate: async () => ({ messageId: `wamid.${run}.o.${nextSeq()}` }) as never,
    sendMedia: async () => ({ messageId: `wamid.${run}.o.${nextSeq()}` }) as never,
  };
  const handler = createOutboundMessageHandler({
    ratePerSecond: 1000,
    rateLimitMaxWaitMs: 5_000,
    now: () => at(0.1),
    sleep: async () => undefined,
    createClient: (o) => {
      created.push({ accessToken: o.accessToken, phoneNumberId: o.phoneNumberId });
      return client;
    },
    ...over,
  });
  return { handler, created };
}

const resolver = (tenantId: string, phoneNumberId: string) =>
  getWhatsappAccessToken(tenantId, cipher, phoneNumberId).then((r) => r?.accessToken ?? null);

describe('token por número no envio (T1.7) — Postgres real', () => {
  after(cleanupTenants);

  it('usa o token DO NÚMERO (decifrado), mesmo havendo token global', async () => {
    const s = await setup(true);
    const h = build({ accessToken: GLOBAL_TOKEN, resolveAccessToken: resolver });
    const r = runJob(h.handler, s.tenantId, { tenantId: s.tenantId, outboundMessageId: s.out.id });
    await r.promise;
    assert.equal(h.created[0]?.accessToken, TENANT_TOKEN);
    assert.equal(h.created[0]?.phoneNumberId, s.phoneNumberId);
    assert.equal((await getMessage(s.tenantId, s.out.id)).status, 'sent');
    assert.ok(!JSON.stringify(r.logs).includes(TENANT_TOKEN));
  });

  it('número sem token próprio cai no token global (legado)', async () => {
    const s = await setup(false);
    const h = build({ accessToken: GLOBAL_TOKEN, resolveAccessToken: resolver });
    await runJob(h.handler, s.tenantId, { tenantId: s.tenantId, outboundMessageId: s.out.id })
      .promise;
    assert.equal(h.created[0]?.accessToken, GLOBAL_TOKEN);
  });

  it('sem token próprio e sem global: falha definitiva `no_access_token`', async () => {
    const s = await setup(false);
    const h = build({ resolveAccessToken: resolver });
    await assert.rejects(
      runJob(h.handler, s.tenantId, { tenantId: s.tenantId, outboundMessageId: s.out.id }).promise,
      /token de acesso/,
    );
    const row = await getMessage(s.tenantId, s.out.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.errorCode, 'no_access_token');
    assert.equal(h.created.length, 0);
  });

  it('chave errada/ausente: falha definitiva `token_unavailable`, sem chamar a Meta nem vazar nada', async () => {
    const s = await setup(true);
    const other = new TokenCipher(new LocalKeyring({ k1: randomBytes(32) }, 'k1'));
    const h = build({
      accessToken: GLOBAL_TOKEN,
      resolveAccessToken: (t, p) =>
        getWhatsappAccessToken(t, other, p).then((r) => r?.accessToken ?? null),
    });
    const cap = captureLogger();
    await assert.rejects(
      runJob(
        h.handler,
        s.tenantId,
        { tenantId: s.tenantId, outboundMessageId: s.out.id },
        {
          logger: cap,
        },
      ).promise,
      /decifrar/,
    );
    const row = await getMessage(s.tenantId, s.out.id);
    assert.equal(row.errorCode, 'token_unavailable');
    assert.equal(h.created.length, 0);
    assert.ok(!JSON.stringify([row, cap.logs]).includes(TENANT_TOKEN));
  });

  it('erro que NÃO é de criptografia (ex.: banco) é repetível', async () => {
    const s = await setup(true);
    const h = build({
      resolveAccessToken: async () => {
        throw new Error('conexão com o banco caiu');
      },
    });
    await assert.rejects(
      runJob(h.handler, s.tenantId, { tenantId: s.tenantId, outboundMessageId: s.out.id }).promise,
      /banco caiu/,
    );
    assert.equal((await getMessage(s.tenantId, s.out.id)).status, 'queued');
  });
});
