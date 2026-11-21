import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import { QUEUES, QueueInspector, toPgConnectionString } from '@megabot/queue';
import pg from 'pg';
import pino from 'pino';
import { loadWorkerConfig } from '../src/config';
import { startWorker } from '../src/worker';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://megabot_app:megabot_pass@localhost:5432/megabot?schema=public';
const TENANT = '11111111-1111-4111-8111-111111111111';

async function waitFor<T>(
  check: () => T | Promise<T>,
  what: string,
  timeoutMs = 20_000,
  /** Detalhe a juntar na mensagem quando o tempo acabar (ex.: o que o processo filho imprimiu). */
  detalhe?: () => string,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) {
      const extra = detalhe?.();
      throw new Error(`Tempo esgotado: ${what}${extra ? `\n${extra}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function dropSchema(schema: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: toPgConnectionString(DATABASE_URL), max: 1 });
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
}

const newSchema = () => `pgboss_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

describe('worker (Postgres real)', () => {
  it('processa um system.ping e desliga de forma graciosa', async () => {
    const schema = newSchema();
    const config = loadWorkerConfig({
      NODE_ENV: 'test',
      DATABASE_URL,
      QUEUE_SCHEMA: schema,
      WORKER_POLL_INTERVAL_SECONDS: '0.5',
      WORKER_SHUTDOWN_TIMEOUT_SECONDS: '10',
    });
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: 'info' },
      { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const worker = await startWorker(config, logger);
    try {
      await worker.client.enqueue(QUEUES.systemPing, { tenantId: TENANT });
      await waitFor(
        () => lines.find((l) => l.event === 'queue.job' && l.outcome === 'completed'),
        'ping concluído',
      );
      const done = lines.find((l) => l.event === 'queue.job');
      assert.equal(done?.tenant_id, TENANT);
      assert.ok(lines.some((l) => l.event === 'worker.ready'));
    } finally {
      await worker.stop();
      await worker.stop(); // idempotente
    }
    assert.ok(lines.some((l) => l.event === 'worker.stopped'));
    await dropSchema(schema);
  });

  it('retenta, e no fim a falha aparece na DLQ lida pelo inspetor', async () => {
    const schema = newSchema();
    const config = loadWorkerConfig({
      NODE_ENV: 'test',
      DATABASE_URL,
      QUEUE_SCHEMA: schema,
      WORKER_POLL_INTERVAL_SECONDS: '0.5',
    });
    const worker = await startWorker(config, pino({ level: 'silent' }));
    const inspector = new QueueInspector({ connectionString: DATABASE_URL, schema });
    try {
      // retryLimit 2 e espera inicial de 2 s: ~2 + 4 s até a DLQ (tolerância no waitFor).
      await worker.client.enqueue(QUEUES.systemPing, {
        tenantId: TENANT,
        simulate: 'retryable-failure',
      });
      await waitFor(
        async () => (await inspector.listJobs({ queue: 'system.ping.dlq' })).length === 1,
        'job na DLQ',
        30_000,
      );
      const [dead] = await inspector.listJobs({ queue: 'system.ping.dlq' });
      assert.equal(dead?.sourceQueue, 'system.ping');
      assert.match(dead?.errorMessage ?? '', /Falha temporária simulada/);
    } finally {
      await inspector.close();
      await worker.stop();
      await dropSchema(schema);
    }
  });
});

describe('main.ts como processo (sinais)', () => {
  const cwd = path.resolve(__dirname, '..');

  function launch(schema: string): {
    child: ChildProcess;
    lines: string[];
    exit: Promise<number | null>;
  } {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd,
      env: {
        // Env MÍNIMO de propósito. O `test` do worker roda com `--env-file=../../.env`, então o
        // .env da máquina entra no process.env; herdar isso num filho com NODE_ENV=production faz
        // o worker morrer na largada por causa de QUALQUER variável que a máquina tenha (eco
        // ligado, OPENAI_API_KEY sem os modelos, storage apontando para a nuvem...). Este teste é
        // sobre SINAIS: ele passa só o que o worker precisa para subir, e nada mais.
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NODE_ENV: 'production',
        DATABASE_URL,
        QUEUE_SCHEMA: schema,
        WORKER_SHUTDOWN_TIMEOUT_SECONDS: '10',
        LOG_LEVEL: 'info',
      },
    });
    const lines: string[] = [];
    child.stdout?.on('data', (d: Buffer) =>
      lines.push(...d.toString().split('\n').filter(Boolean)),
    );
    child.stderr?.on('data', (d: Buffer) =>
      lines.push(...d.toString().split('\n').filter(Boolean)),
    );
    const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, lines, exit };
  }

  it('SIGTERM: encerra com código 0 depois de "worker.stopped"', async () => {
    const schema = newSchema();
    const { child, lines, exit } = launch(schema);
    try {
      await waitFor(
        () => lines.some((l) => l.includes('worker.ready')),
        'worker pronto',
        30_000,
        () => `Saída do worker:\n${lines.join('\n') || '(o processo não imprimiu nada)'}`,
      );
      child.kill('SIGTERM');
      const code = await exit;
      assert.equal(code, 0);
      assert.ok(lines.some((l) => l.includes('worker.signal')));
      assert.ok(lines.some((l) => l.includes('worker.stopped')));
    } finally {
      child.kill('SIGKILL');
      await dropSchema(schema);
    }
  });

  it('config inválida: sai com código 1 e lista o problema, sem subir', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
    });
    let output = '';
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(output, /DATABASE_URL/);
  });
});
