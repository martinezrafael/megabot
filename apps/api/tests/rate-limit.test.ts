import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers';

describe('Rate limit', () => {
  it('rotas em geral: acima do limite responde 429 com Retry-After e o formato padrão de erro', async () => {
    const t = await startTestApp({
      config: { rateLimit: { windowMs: 60_000, max: 3, authMax: 1000 } },
    });
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await t.api('/me')).status, 401, `requisição ${i + 1} ainda é atendida`);
      }

      const blocked = await t.api('/me');
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'deve informar Retry-After');

      const body = (await blocked.json()) as {
        statusCode: number;
        message: string;
        requestId: string;
      };
      assert.equal(body.statusCode, 429);
      assert.equal(body.message, 'Muitas requisições. Tente novamente em instantes.');
      assert.equal(body.requestId, blocked.headers.get('x-request-id'));
    } finally {
      await t.close();
    }
  });

  it('rotas de autenticação têm limite próprio, mais rígido (anti força bruta)', async () => {
    const t = await startTestApp({
      config: { rateLimit: { windowMs: 60_000, max: 1000, authMax: 3 } },
    });
    try {
      const attempt = () =>
        t.api('/api/auth/sign-in/email', {
          body: { email: 'alvo@auth.test', password: 'tentativa-errada' },
        });

      for (let i = 0; i < 3; i++) {
        assert.equal((await attempt()).status, 401);
      }
      assert.equal((await attempt()).status, 429);

      // O limite rígido não afeta as demais rotas.
      assert.equal((await t.api('/me')).status, 401);
    } finally {
      await t.close();
    }
  });

  it('get-session (chamada a cada página) não consome o limite rígido de auth', async () => {
    const t = await startTestApp({
      config: { rateLimit: { windowMs: 60_000, max: 1000, authMax: 2 } },
    });
    try {
      for (let i = 0; i < 6; i++) {
        assert.equal((await t.api('/api/auth/get-session')).status, 200);
      }
    } finally {
      await t.close();
    }
  });

  it('/health e /health/ready nunca são limitados', async () => {
    const t = await startTestApp({
      config: { rateLimit: { windowMs: 60_000, max: 2, authMax: 2 } },
    });
    try {
      for (let i = 0; i < 6; i++) {
        assert.equal((await t.api('/health')).status, 200);
        assert.equal((await t.api('/health/ready')).status, 200);
      }
    } finally {
      await t.close();
    }
  });
});
