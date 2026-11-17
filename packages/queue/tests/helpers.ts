import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { QueueClient, toPgConnectionString, type LogFields, type QueueClientOptions } from '../src';

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://megabot_app:megabot_pass@localhost:5432/megabot?schema=public';

export interface LogLine extends LogFields {
  level: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
}

/** Logger/metrics que guardam tudo em memória para os testes conferirem. */
export function createRecorder() {
  const logs: LogLine[] = [];
  const metrics: Array<{ name: string; labels?: Record<string, string>; value: number }> = [];
  const push =
    (level: LogLine['level']) =>
    (fields: LogFields, message?: string): void => {
      logs.push({ level, ...fields, message });
    };
  return {
    logs,
    metrics,
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    metricsSink: {
      increment: (name: string, labels?: Record<string, string>, value = 1) =>
        void metrics.push({ name, labels, value }),
      timing: (name: string, value: number, labels?: Record<string, string>) =>
        void metrics.push({ name, labels, value }),
    },
  };
}

/** Cada teste usa um schema próprio do pg-boss (isolado) e o apaga no final. */
export async function withIsolatedQueue(
  run: (ctx: {
    client: QueueClient;
    schema: string;
    recorder: ReturnType<typeof createRecorder>;
  }) => Promise<void>,
  options: Partial<QueueClientOptions> = {},
): Promise<void> {
  const schema = `pgboss_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const recorder = createRecorder();
  const client = new QueueClient({
    connectionString: DATABASE_URL,
    schema,
    pollingIntervalSeconds: 0.5,
    logger: recorder.logger,
    metrics: recorder.metricsSink,
    ...options,
  });
  try {
    await client.start();
    await run({ client, schema, recorder });
  } finally {
    await client.stop({ timeoutMs: 5_000 }).catch(() => undefined);
    const pool = new pg.Pool({ connectionString: toPgConnectionString(DATABASE_URL), max: 1 });
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
}

export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = 15_000, intervalMs = 100, what = 'condição' } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Tempo esgotado esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
