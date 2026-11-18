import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadWorkerConfig, WorkerConfigError } from '../src/config';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public' };

describe('config do worker', () => {
  it('aplica os padrões', () => {
    const config = loadWorkerConfig({ ...base, NODE_ENV: 'production' });
    assert.equal(config.poolSize, 4);
    assert.equal(config.pollIntervalSeconds, 2);
    assert.equal(config.shutdownTimeoutMs, 30_000);
    assert.equal(config.queueSchema, 'pgboss');
    assert.equal(config.logLevel, 'info');
  });

  it('WhatsApp: padrões e variáveis do envio', () => {
    const d = loadWorkerConfig({ ...base, NODE_ENV: 'production' }).whatsapp;
    assert.equal(d.accessToken, undefined);
    assert.equal(d.baseUrl, undefined);
    assert.equal(d.ratePerSecond, 80);
    assert.equal(d.rateLimitMaxWaitMs, 5_000);

    const c = loadWorkerConfig({
      ...base,
      WHATSAPP_API_TOKEN: 'abc',
      WHATSAPP_API_BASE_URL: 'http://localhost:9999',
      WHATSAPP_RATE_LIMIT_PER_SECOND: '10',
      WHATSAPP_RATE_LIMIT_MAX_WAIT_MS: '0',
    }).whatsapp;
    assert.deepEqual(c, {
      accessToken: 'abc',
      baseUrl: 'http://localhost:9999',
      ratePerSecond: 10,
      rateLimitMaxWaitMs: 0,
    });
  });

  it('WhatsApp: rejeita limite inválido e URL inválida', () => {
    assert.throws(
      () => loadWorkerConfig({ ...base, WHATSAPP_RATE_LIMIT_PER_SECOND: '0' }),
      WorkerConfigError,
    );
    assert.throws(
      () => loadWorkerConfig({ ...base, WHATSAPP_API_BASE_URL: 'não é url' }),
      WorkerConfigError,
    );
  });

  it('em teste o log é silencioso, a menos que LOG_LEVEL seja definido', () => {
    assert.equal(loadWorkerConfig({ ...base, NODE_ENV: 'test' }).logLevel, 'silent');
    assert.equal(
      loadWorkerConfig({ ...base, NODE_ENV: 'test', LOG_LEVEL: 'debug' }).logLevel,
      'debug',
    );
  });

  it('falha rápida: lista todos os problemas de uma vez', () => {
    assert.throws(
      () =>
        loadWorkerConfig({
          DATABASE_URL: 'mysql://x',
          WORKER_POOL_SIZE: 'muitos',
          QUEUE_SCHEMA: 'x; DROP',
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkerConfigError);
        assert.equal(error.issues.length, 3);
        assert.match(error.message, /DATABASE_URL/);
        assert.match(error.message, /WORKER_POOL_SIZE/);
        assert.match(error.message, /QUEUE_SCHEMA/);
        return true;
      },
    );
  });

  it('DATABASE_URL é obrigatória e variável vazia conta como ausente', () => {
    assert.throws(() => loadWorkerConfig({}), /DATABASE_URL/);
    assert.throws(() => loadWorkerConfig({ DATABASE_URL: '' }), /DATABASE_URL/);
    assert.equal(loadWorkerConfig({ ...base, LOG_LEVEL: '' }).logLevel, 'info');
  });
});
