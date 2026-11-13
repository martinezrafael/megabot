import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers';

describe('Health check', () => {
  it('liveness: GET /health responde ok sem consultar dependências', async () => {
    const t = await startTestApp({
      // Mesmo com o banco "fora do ar", o processo está vivo.
      dbPing: async () => {
        throw new Error('banco fora');
      },
    });
    try {
      const res = await t.api('/health');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    } finally {
      await t.close();
    }
  });

  it('readiness: GET /health/ready confere o banco de verdade', async () => {
    const t = await startTestApp();
    try {
      const res = await t.api('/health/ready');
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') ?? '', /no-store/);

      const body = (await res.json()) as { status: string; info: { database: { status: string } } };
      assert.equal(body.status, 'ok');
      assert.equal(body.info.database.status, 'up');
    } finally {
      await t.close();
    }
  });

  it('readiness: banco fora do ar vira 503 no formato padrão de erro', async () => {
    const t = await startTestApp({
      dbPing: async () => {
        throw new Error('connection refused');
      },
    });
    try {
      const res = await t.api('/health/ready');
      assert.equal(res.status, 503);

      const body = (await res.json()) as {
        statusCode: number;
        requestId: string;
        details: { status: string; error: { database: { status: string; message: string } } };
      };
      assert.equal(body.statusCode, 503);
      assert.ok(body.requestId);
      assert.equal(body.details.status, 'error');
      assert.equal(body.details.error.database.status, 'down');
      assert.equal(body.details.error.database.message, 'connection refused');
    } finally {
      await t.close();
    }
  });
});
