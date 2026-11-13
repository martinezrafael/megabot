import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrl } from '../src/logging/sanitize-url';
import { cookieFrom, lastLink, startTestApp, waitForEmail, WEB_URL, type TestApp } from './helpers';

type LogLine = Record<string, unknown> & {
  msg?: string;
  request_id?: string;
  tenant_id?: string;
  user_id?: string;
  level?: number;
  req?: { id?: string; method?: string; url?: string };
  res?: { statusCode?: number };
};

describe('Logger pino com request_id e tenant_id', () => {
  let t: TestApp;
  const raw: string[] = [];
  const logs = (): LogLine[] =>
    raw.flatMap((chunk) => chunk.split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  const completed = (predicate: (l: LogLine) => boolean) =>
    logs().filter((l) => l.msg === 'request completed' && predicate(l));

  before(async () => {
    t = await startTestApp({
      config: { logLevel: 'info' },
      logStream: { write: (chunk: string) => void raw.push(chunk) },
    });
  });
  after(async () => {
    await t.close();
  });

  it('cada resposta devolve x-request-id e o mesmo id aparece no log', async () => {
    const res = await t.api('/me');
    const id = res.headers.get('x-request-id');
    assert.ok(id);

    const [line] = completed((l) => l.request_id === id);
    assert.ok(line, 'log "request completed" não encontrado');
    assert.equal(line.req?.id, id);
    assert.equal(line.req?.method, 'GET');
    assert.equal(line.req?.url, '/me');
    assert.equal(line.res?.statusCode, 401);
    assert.equal(line.level, 40, 'resposta 401 deve ser registrada como warn');
    assert.equal(line.tenant_id, undefined, 'requisição anônima não tem tenant_id');
  });

  it('reaproveita um x-request-id válido enviado pelo cliente', async () => {
    const res = await t.api('/me', { headers: { 'x-request-id': 'trace-abc-12345' } });
    assert.equal(res.headers.get('x-request-id'), 'trace-abc-12345');
    assert.equal(completed((l) => l.request_id === 'trace-abc-12345').length, 1);
  });

  it('descarta x-request-id inválido (evita injeção de log)', async () => {
    const res = await t.api('/me', { headers: { 'x-request-id': 'ruim "},{"msg":"falso' } });
    const id = res.headers.get('x-request-id');
    assert.ok(id);
    assert.notEqual(id, 'ruim "},{"msg":"falso');
    assert.match(id, /^[0-9a-f-]{36}$/);
  });

  it('requisição autenticada registra tenant_id e user_id', async () => {
    const email = t.newEmail('logs');
    await t.api('/api/auth/sign-up/email', {
      body: {
        name: 'Lia Logs',
        email,
        password: 'senha-super-segura-123',
        callbackURL: `${WEB_URL}/dashboard`,
      },
    });
    await waitForEmail(t.mailer, email);
    const verify = await t.api(lastLink(t.mailer, email).replace(t.baseUrl, ''));
    const cookie = cookieFrom(verify);

    const me = await t.api('/me', { cookie });
    assert.equal(me.status, 200);
    const body = (await me.json()) as { user: { id: string }; tenant: { id: string } };
    const id = me.headers.get('x-request-id');

    const [line] = completed((l) => l.request_id === id);
    assert.ok(line);
    assert.equal(line.tenant_id, body.tenant.id);
    assert.equal(line.user_id, body.user.id);
    assert.equal(line.res?.statusCode, 200);
    assert.equal(line.level, 30);
  });

  it('as rotas de auth também são registradas', async () => {
    const res = await t.api('/api/auth/sign-in/email', {
      body: { email: 'nao@existe.test', password: 'xxxxxxxxx' },
    });
    const id = res.headers.get('x-request-id');
    assert.ok(id);
    assert.equal(completed((l) => l.request_id === id).length, 1);
  });

  it('nunca grava cookie, token da URL nem a sonda /health', async () => {
    await t.api('/me?token=SEGREDO-NA-URL', {
      cookie: 'better-auth.session_token=VALOR-SECRETO-DO-COOKIE',
    });
    await t.api('/health');

    const everything = raw.join('');
    assert.ok(!everything.includes('SEGREDO-NA-URL'), 'query string vazou para o log');
    assert.ok(!everything.includes('VALOR-SECRETO-DO-COOKIE'), 'cookie vazou para o log');
    assert.equal(
      completed((l) => l.req?.url === '/health').length,
      0,
      '/health não deve ser logado',
    );
  });

  it('sanitizeUrl remove query string e o token do reset de senha', () => {
    assert.equal(
      sanitizeUrl('/api/auth/verify-email?token=abc&callbackURL=x'),
      '/api/auth/verify-email',
    );
    assert.equal(
      sanitizeUrl('/api/auth/reset-password/TOKEN123?callbackURL=x'),
      '/api/auth/reset-password/[redacted]',
    );
    assert.equal(sanitizeUrl(undefined), '');
  });
});
