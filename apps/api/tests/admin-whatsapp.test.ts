import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { LocalKeyring, TokenCipher, getWhatsappAccessToken, withTenant } from '@megabot/database';
import { signUpVerified, startTestApp, type TestApp } from './helpers';

const TOKEN = `EAAG${randomBytes(18).toString('hex')}-SEGREDO-NAO-VAZAR`;
let seq = 0;
const newPhoneNumberId = () => `${Date.now()}${String(++seq).padStart(3, '0')}`;
const cipher = new TokenCipher(new LocalKeyring({ test: randomBytes(32) }, 'test'));

describe('Admin: conexão manual de número do WhatsApp (T1.7)', () => {
  let t: TestApp;
  const logs: string[] = [];
  let adminCookie = '';
  let memberCookie = '';
  let tenantId = '';
  let otherTenantId = '';

  const body = (over: Record<string, unknown> = {}) => ({
    tenantId,
    phoneNumberId: newPhoneNumberId(),
    wabaId: 'waba-1',
    accessToken: TOKEN,
    ...over,
  });

  before(async () => {
    t = await startTestApp({
      platformAdminLabels: ['plataforma'],
      config: { logLevel: 'info', tokenCipher: cipher },
      logStream: { write: (chunk: string) => void logs.push(chunk) },
    });
    adminCookie = await signUpVerified(t, t.newEmail('plataforma'), 'Admin');
    memberCookie = await signUpVerified(t, t.newEmail('cliente'), 'Cliente');
    const other = await signUpVerified(t, t.newEmail('outro'), 'Outro');
    const me = async (cookie: string) =>
      ((await (await t.api('/me', { cookie })).json()) as { tenant: { id: string } }).tenant.id;
    tenantId = await me(memberCookie);
    otherTenantId = await me(other);
  });
  after(async () => {
    await t.close();
  });

  it('sem sessão: 401; usuário comum: 403; nenhum dos dois grava nada', async () => {
    const payload = body();
    assert.equal((await t.api('/admin/whatsapp/connections', { body: payload })).status, 401);
    assert.equal(
      (await t.api('/admin/whatsapp/connections', { body: payload, cookie: memberCookie })).status,
      403,
    );
    assert.equal(
      (await t.api(`/admin/whatsapp/connections?tenantId=${tenantId}`, { cookie: memberCookie }))
        .status,
      403,
    );
    const rows = await withTenant(tenantId, (tx) =>
      tx.whatsappConnection.count({ where: { phoneNumberId: payload.phoneNumberId } }),
    );
    assert.equal(rows, 0);
  });

  it('valida o corpo (400) sem ecoar o token', async () => {
    const bad = [
      body({ tenantId: 'nao-e-uuid' }),
      body({ phoneNumberId: '12ab' }),
      body({ accessToken: 'curto' }),
      { ...body(), extra: 'campo-desconhecido' },
    ];
    for (const payload of bad) {
      const res = await t.api('/admin/whatsapp/connections', {
        body: payload,
        cookie: adminCookie,
      });
      assert.equal(res.status, 400);
      assert.ok(!(await res.text()).includes(TOKEN));
    }
  });

  it('conecta: 201, devolve só metadados e guarda o token cifrado', async () => {
    const payload = body({ displayPhoneNumber: '+55 11 99999-0000' });
    const res = await t.api('/admin/whatsapp/connections', {
      body: payload,
      cookie: adminCookie,
    });
    const text = await res.text();
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(!text.includes(TOKEN), 'a resposta não pode conter o token');
    const json = JSON.parse(text) as {
      created: boolean;
      connection: {
        hasToken: boolean;
        tokenKeyId: string;
        phoneNumberId: string;
        tenantId: string;
      };
    };
    assert.equal(json.created, true);
    assert.equal(json.connection.hasToken, true);
    assert.equal(json.connection.tokenKeyId, 'test');
    assert.equal(json.connection.tenantId, tenantId);
    assert.ok(!('accessToken' in json.connection));

    // No banco: só o envelope; e ele decifra para o token original.
    const rows = await withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<
          Array<{ access_token_envelope: string }>
        >`SELECT access_token_envelope FROM whatsapp_connections WHERE phone_number_id = ${payload.phoneNumberId}`,
    );
    assert.ok(!rows[0]!.access_token_envelope.includes(TOKEN));
    // Quem decifra é o mesmo chaveiro da API (o do teste).
    const found = await getWhatsappAccessToken(tenantId, cipher);
    assert.equal(found?.accessToken, TOKEN);
  });

  it('reconectar o mesmo número: 200 e created=false', async () => {
    const payload = body();
    await t.api('/admin/whatsapp/connections', { body: payload, cookie: adminCookie });
    const res = await t.api('/admin/whatsapp/connections', {
      body: { ...payload, wabaId: 'waba-novo' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { created: boolean; connection: { wabaId: string } };
    assert.equal(json.created, false);
    assert.equal(json.connection.wabaId, 'waba-novo');
  });

  it('número de outra empresa: 409; empresa inexistente: 404', async () => {
    const payload = body();
    assert.equal(
      (await t.api('/admin/whatsapp/connections', { body: payload, cookie: adminCookie })).status,
      201,
    );
    const conflict = await t.api('/admin/whatsapp/connections', {
      body: { ...payload, tenantId: otherTenantId },
      cookie: adminCookie,
    });
    assert.equal(conflict.status, 409);
    assert.ok(!(await conflict.text()).includes(TOKEN));

    const missing = await t.api('/admin/whatsapp/connections', {
      body: body({ tenantId: randomUUID() }),
      cookie: adminCookie,
    });
    assert.equal(missing.status, 404);
  });

  it('lista as conexões sem expor o token', async () => {
    const res = await t.api(`/admin/whatsapp/connections?tenantId=${tenantId}`, {
      cookie: adminCookie,
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes(TOKEN));
    const list = JSON.parse(text) as Array<{ hasToken: boolean }>;
    assert.ok(list.length >= 1);
    assert.ok(list.every((c) => c.hasToken));
    assert.equal(
      (await t.api('/admin/whatsapp/connections?tenantId=xx', { cookie: adminCookie })).status,
      400,
    );
  });

  it('logs e métricas têm tenant_id e NENHUM log contém o token', async () => {
    const lines = logs.flatMap((chunk) => chunk.split('\n').filter(Boolean));
    assert.ok(lines.length > 0);
    assert.ok(!logs.join('').includes(TOKEN), 'token apareceu nos logs!');
    const events = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === 'whatsapp.connection.admin');
    assert.ok(events.length >= 3);
    assert.ok(events.every((e) => e.tenant_id));
    const metric = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.metric === 'whatsapp_connection_admin_total' && l.outcome === 'created');
    assert.ok(metric);
    assert.equal(metric.tenant_id, tenantId);
  });

  it('sem TOKEN_ENCRYPTION_KEYS: 503 e nada é gravado', async () => {
    const t2 = await startTestApp({
      platformAdminLabels: ['plataforma'],
      config: { tokenCipher: null },
    });
    try {
      const cookie = await signUpVerified(t2, t2.newEmail('plataforma'), 'Admin 2');
      const tid = ((await (await t2.api('/me', { cookie })).json()) as { tenant: { id: string } })
        .tenant.id;
      const payload = body({ tenantId: tid });
      const res = await t2.api('/admin/whatsapp/connections', { body: payload, cookie });
      assert.equal(res.status, 503);
      assert.equal(
        await withTenant(tid, (tx) =>
          tx.whatsappConnection.count({ where: { phoneNumberId: payload.phoneNumberId } }),
        ),
        0,
      );
    } finally {
      await t2.close();
    }
  });
});
