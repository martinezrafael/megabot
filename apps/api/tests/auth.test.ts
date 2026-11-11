import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { listUserTenants, prisma } from '@megabot/database';
import { cookieFrom, lastLink, startTestApp, waitForEmail, WEB_URL, type TestApp } from './helpers';

const PASSWORD = 'senha-super-segura-123';

describe('Autenticação (T0.5)', () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t.close();
  });

  describe('proteção das rotas (guard global)', () => {
    it('GET /health é público', async () => {
      const res = await t.api('/health');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    });

    it('GET /me sem sessão retorna 401', async () => {
      const res = await t.api('/me');
      assert.equal(res.status, 401);
    });

    it('GET /me com cookie inválido retorna 401', async () => {
      const res = await t.api('/me', { cookie: 'better-auth.session_token=invalido' });
      assert.equal(res.status, 401);
    });
  });

  describe('cadastro, verificação de e-mail e login', () => {
    it('fluxo completo: cadastro -> login bloqueado -> verificar -> logado com tenant', async () => {
      const email = t.newEmail('ana');

      // 1. Cadastro
      const signUp = await t.api('/api/auth/sign-up/email', {
        body: { name: 'Ana Souza', email, password: PASSWORD, callbackURL: `${WEB_URL}/dashboard` },
      });
      assert.equal(signUp.status, 200);
      // Ainda sem sessão: precisa verificar o e-mail antes.
      assert.equal(signUp.headers.getSetCookie().length, 0);

      // 2. Login bloqueado enquanto o e-mail não foi verificado
      const blocked = await t.api('/api/auth/sign-in/email', {
        body: { email, password: PASSWORD },
      });
      assert.equal(blocked.status, 403);

      // 3. E-mail de verificação chegou; abrir o link verifica e já cria a sessão
      await waitForEmail(t.mailer, email);
      const verify = await t.api(lastLink(t.mailer, email).replace(t.baseUrl, ''));
      assert.equal(verify.status, 302);
      assert.ok(verify.headers.get('location')?.startsWith(`${WEB_URL}/dashboard`));
      const cookie = cookieFrom(verify);
      assert.ok(cookie.includes('session_token'));

      // 4. /me devolve usuário + tenant OWNER (provisionado automaticamente)
      const me = await t.api('/me', { cookie });
      assert.equal(me.status, 200);
      const body = (await me.json()) as {
        user: { email: string; emailVerified: boolean };
        tenant: { id: string; role: string } | null;
      };
      assert.equal(body.user.email, email);
      assert.equal(body.user.emailVerified, true);
      assert.equal(body.tenant?.role, 'OWNER');

      // 5. Login normal agora funciona
      const signIn = await t.api('/api/auth/sign-in/email', {
        body: { email, password: PASSWORD },
      });
      assert.equal(signIn.status, 200);
      assert.ok(cookieFrom(signIn).includes('session_token'));

      // 6. Logout invalida a sessão
      const out = await t.api('/api/auth/sign-out', { method: 'POST', body: {}, cookie });
      assert.equal(out.status, 200);
      assert.equal((await t.api('/me', { cookie })).status, 401);
    });

    it('o cadastro provisiona exatamente 1 tenant e 1 membership OWNER', async () => {
      const email = t.newEmail('bruno');
      await t.api('/api/auth/sign-up/email', {
        body: { name: 'Bruno', email, password: PASSWORD },
      });

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      const tenants = await listUserTenants(user.id);
      assert.equal(tenants.length, 1);
      assert.equal(tenants[0].role, 'OWNER');
    });

    it('rejeita senha curta', async () => {
      const res = await t.api('/api/auth/sign-up/email', {
        body: { name: 'X', email: t.newEmail('curta'), password: '123' },
      });
      assert.equal(res.status, 400);
    });

    it('rejeita senha incorreta', async () => {
      const email = t.newEmail('carla');
      await t.api('/api/auth/sign-up/email', {
        body: { name: 'Carla', email, password: PASSWORD },
      });
      await waitForEmail(t.mailer, email);
      await t.api(lastLink(t.mailer, email).replace(t.baseUrl, ''));

      const res = await t.api('/api/auth/sign-in/email', {
        body: { email, password: 'errada-errada' },
      });
      assert.equal(res.status, 401);
    });
  });

  describe('recuperação de senha', () => {
    it('fluxo completo: pedir -> link -> nova senha -> login com a nova', async () => {
      const email = t.newEmail('diego');
      const newPassword = 'outra-senha-bem-forte-456';

      await t.api('/api/auth/sign-up/email', {
        body: { name: 'Diego', email, password: PASSWORD },
      });
      await waitForEmail(t.mailer, email);
      await t.api(lastLink(t.mailer, email).replace(t.baseUrl, '')); // verifica o e-mail
      t.mailer.outbox.length = 0;

      // 1. Pede a redefinição
      const request = await t.api('/api/auth/request-password-reset', {
        body: { email, redirectTo: `${WEB_URL}/reset-password` },
      });
      assert.equal(request.status, 200);

      // 2. Abre o link do e-mail: redireciona para o front com o token na URL
      await waitForEmail(t.mailer, email);
      const link = await t.api(lastLink(t.mailer, email).replace(t.baseUrl, ''));
      assert.equal(link.status, 302);
      const location = new URL(link.headers.get('location') as string);
      assert.equal(`${location.origin}${location.pathname}`, `${WEB_URL}/reset-password`);
      const token = location.searchParams.get('token');
      assert.ok(token);

      // 3. Define a nova senha
      const reset = await t.api('/api/auth/reset-password', { body: { newPassword, token } });
      assert.equal(reset.status, 200);

      // 4. Senha antiga não funciona mais; a nova sim
      const oldLogin = await t.api('/api/auth/sign-in/email', {
        body: { email, password: PASSWORD },
      });
      assert.equal(oldLogin.status, 401);
      const newLogin = await t.api('/api/auth/sign-in/email', {
        body: { email, password: newPassword },
      });
      assert.equal(newLogin.status, 200);
    });

    it('não revela se o e-mail existe', async () => {
      const res = await t.api('/api/auth/request-password-reset', {
        body: { email: t.newEmail('inexistente'), redirectTo: `${WEB_URL}/reset-password` },
      });
      assert.equal(res.status, 200);
    });
  });

  describe('login com Google', () => {
    it('inicia o OAuth redirecionando para o Google com o redirect_uri correto', async () => {
      const res = await t.api('/api/auth/sign-in/social', {
        body: { provider: 'google', callbackURL: `${WEB_URL}/dashboard` },
      });
      assert.equal(res.status, 200);
      const { url } = (await res.json()) as { url: string };
      const target = new URL(url);

      assert.equal(target.host, 'accounts.google.com');
      assert.equal(target.searchParams.get('client_id'), 'test-google-client-id');
      assert.equal(
        target.searchParams.get('redirect_uri'),
        `${t.baseUrl}/api/auth/callback/google`,
      );
    });
  });

  describe('CORS e CSRF', () => {
    it('libera o front-end configurado, com credenciais', async () => {
      const res = await t.api('/health', { origin: WEB_URL });
      assert.equal(res.headers.get('access-control-allow-origin'), WEB_URL);
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    });

    it('não libera outras origens', async () => {
      const res = await t.api('/health', { origin: 'https://evil.example' });
      assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://evil.example');
    });

    it('rotas de auth também respondem ao preflight do front', async () => {
      const res = await fetch(`${t.baseUrl}/api/auth/sign-in/email`, {
        method: 'OPTIONS',
        headers: { Origin: WEB_URL, 'Access-Control-Request-Method': 'POST' },
      });
      assert.ok(res.status === 204 || res.status === 200);
      assert.equal(res.headers.get('access-control-allow-origin'), WEB_URL);
    });
  });

  describe('resiliência', () => {
    it('cadastro continua funcionando (e o processo não cai) se o SMTP falhar', async () => {
      const broken = await startTestApp({
        mailer: {
          send: async () => {
            throw new Error('SMTP fora do ar');
          },
        },
      });
      try {
        const res = await broken.api('/api/auth/sign-up/email', {
          body: { name: 'Eva', email: broken.newEmail('eva'), password: PASSWORD },
        });
        assert.equal(res.status, 200);
        await new Promise((r) => setTimeout(r, 100)); // dá tempo para a rejeição (tratada) acontecer
        assert.equal((await broken.api('/health')).status, 200);
      } finally {
        await broken.close();
      }
    });
  });
});
