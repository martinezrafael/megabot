import { z } from 'zod';

/**
 * Configuração do worker, validada com Zod na inicialização ("falha rápida", como na API):
 * todos os problemas são listados de uma vez e o processo não sobe.
 */
export interface WorkerConfig {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Conexões do pool do pg-boss neste processo. */
  poolSize: number;
  /** De quanto em quanto tempo olhar as filas, em segundos. */
  pollIntervalSeconds: number;
  /** Tempo máximo esperando jobs em andamento terminarem ao desligar. */
  shutdownTimeoutMs: number;
  /** Schema do pg-boss (padrão `pgboss`; só os testes mudam). */
  queueSchema: string;
}

export class WorkerConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Configuração do worker inválida. Corrija o .env e tente de novo:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'WorkerConfigError';
  }
}

const positiveInt = z.coerce.number({ error: 'precisa ser um número' }).int().positive();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z
    .string({ error: 'obrigatória' })
    .regex(/^postgres(ql)?:\/\//, 'precisa começar com postgresql://'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  WORKER_POOL_SIZE: positiveInt.max(50).default(4),
  WORKER_POLL_INTERVAL_SECONDS: z.coerce.number().min(0.5).max(60).default(2),
  WORKER_SHUTDOWN_TIMEOUT_SECONDS: positiveInt.max(600).default(30),
  QUEUE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'use só letras minúsculas, números e _')
    .default('pgboss'),
});

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // Variável vazia (`LOG_LEVEL=`) conta como "não definida".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new WorkerConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(geral)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    poolSize: e.WORKER_POOL_SIZE,
    pollIntervalSeconds: e.WORKER_POLL_INTERVAL_SECONDS,
    shutdownTimeoutMs: e.WORKER_SHUTDOWN_TIMEOUT_SECONDS * 1000,
    queueSchema: e.QUEUE_SCHEMA,
  };
}
