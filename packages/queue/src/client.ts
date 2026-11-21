import { PgBoss } from 'pg-boss';
import { toPgConnectionString, PGBOSS_SCHEMA } from './connection';
import {
  ALL_QUEUES,
  DLQ_RETENTION_SECONDS,
  type PayloadInputOf,
  type PayloadOf,
  type QueueDefinition,
} from './definitions';
import { describeError, isRetryable } from './errors';
import { isUuid } from './job-id';
import {
  METRIC,
  noopLogger,
  noopMetrics,
  type LogFields,
  type QueueLogger,
  type QueueMetrics,
} from './observability';

export interface QueueClientOptions {
  /** URL do Postgres (aceita o `?schema=public` do Prisma). */
  connectionString: string;
  /** Schema do pg-boss. Padrão: `pgboss` (ADR 0005). Só os testes mudam isto. */
  schema?: string;
  /** Tamanho do pool de conexões deste processo (padrão 4). Some ao pool da API ao dimensionar o banco. */
  poolSize?: number;
  /** Filas que este processo cria/usa. Padrão: todas. */
  queues?: readonly QueueDefinition[];
  /** De quanto em quanto tempo o worker olha a fila, em segundos (padrão 2). */
  pollingIntervalSeconds?: number;
  logger?: QueueLogger;
  metrics?: QueueMetrics;
}

export interface EnqueueOptions {
  /**
   * Identificador do job (UUID). Enfileirar duas vezes com o mesmo `jobId` cria UM job só:
   * é assim que o enfileiramento fica idempotente (ex.: usar o id do `webhook_events`).
   */
  jobId?: string;
  /** Só executar depois de N segundos. */
  startAfterSeconds?: number;
  /** Maior número = executa antes (padrão 0). */
  priority?: number;
}

export interface EnqueueResult {
  /** Id do job criado; null se já existia um com o mesmo `jobId`. */
  jobId: string | null;
  deduplicated: boolean;
}

/** O que o handler recebe. */
export interface JobContext<D extends QueueDefinition> {
  jobId: string;
  tenantId: string;
  payload: PayloadOf<D>;
  /** Tentativa atual (começa em 1). */
  attempt: number;
  /** Total de tentativas antes de ir para a DLQ. */
  maxAttempts: number;
  /** Abortado quando o job expira ou o processo está desligando: pare o trabalho se puder. */
  signal: AbortSignal;
  /** Logger que já inclui `tenant_id`, `queue` e `job_id`. */
  logger: QueueLogger;
}

/**
 * Handler de uma fila. Retornar = sucesso. Lançar erro = falha:
 *  - `NonRetryableError` (ou qualquer erro com `retryable: false`): vai direto para a DLQ;
 *  - qualquer outro: o pg-boss repete com espera crescente até esgotar as tentativas e então vai para a DLQ.
 */
export type JobHandler<D extends QueueDefinition> = (ctx: JobContext<D>) => Promise<void>;

type JobOutcome = 'completed' | 'retry' | 'dead_letter';

interface BossJob {
  id: string;
  data: unknown;
  retryCount: number;
  retryLimit: number;
  signal: AbortSignal;
}

type JobResult = { id: string; status: 'completed' | 'failed' | 'deadletter'; output?: object };

const UNKNOWN_TENANT = 'unknown';

export class QueueClient {
  readonly boss: PgBoss;
  private readonly queues: readonly QueueDefinition[];
  private readonly logger: QueueLogger;
  private readonly metrics: QueueMetrics;
  private readonly pollingIntervalSeconds: number;
  private started = false;

  constructor(options: QueueClientOptions) {
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.queues = options.queues ?? ALL_QUEUES;
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;

    this.boss = new PgBoss({
      connectionString: toPgConnectionString(options.connectionString),
      schema: options.schema ?? PGBOSS_SCHEMA,
      max: options.poolSize ?? 4,
      application_name: 'megabot-queue',
    });

    // Sem este ouvinte, um erro do pg-boss derrubaria o processo (EventEmitter sem 'error').
    this.boss.on('error', (error) => {
      this.logger.error({ event: 'queue.error', ...describeError(error) }, 'Erro no pg-boss');
    });
    this.boss.on('warning', (warning) => {
      this.logger.warn({ event: 'queue.warning', warning }, 'Aviso do pg-boss');
    });
  }

  /** Conecta, instala/atualiza o schema do pg-boss e cria (ou ajusta) as filas e as DLQs. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    await this.ensureQueues();
    this.started = true;
    this.logger.info(
      { event: 'queue.started', queues: this.queues.map((q) => q.name) },
      'Filas prontas',
    );
  }

  /**
   * Desliga com elegância: para de buscar jobs novos, espera os que estão rodando terminarem
   * (até `timeoutMs`) e fecha o pool. Chamar mais de uma vez é seguro.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.started) {
      // start() pode ter falhado no meio; ainda assim fecha o pool.
      await this.boss.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
      return;
    }
    this.started = false;
    await this.boss.stop({ graceful: true, close: true, timeout: options.timeoutMs ?? 30_000 });
    this.logger.info({ event: 'queue.stopped' }, 'Filas encerradas');
  }

  /** Cria as filas que faltam e atualiza as opções das que já existem (as DLQs primeiro: há chave estrangeira). */
  async ensureQueues(): Promise<void> {
    for (const def of this.queues) {
      await this.upsertQueue(def.deadLetterName, {
        retryLimit: 0,
        expireInSeconds: 15 * 60,
        retentionSeconds: DLQ_RETENTION_SECONDS,
        deleteAfterSeconds: DLQ_RETENTION_SECONDS,
      });
    }
    for (const def of this.queues) {
      await this.upsertQueue(
        def.name,
        {
          retryLimit: def.retry.retryLimit,
          retryDelay: def.retry.retryDelaySeconds,
          retryBackoff: true,
          retryDelayMax: def.retry.retryDelayMaxSeconds,
          expireInSeconds: def.expireInSeconds,
          deleteAfterSeconds: def.keepCompletedSeconds,
        },
        def.deadLetterName,
      );
    }
  }

  private async upsertQueue(
    name: string,
    options: Record<string, number | boolean>,
    deadLetter?: string,
  ): Promise<void> {
    const existing = await this.boss.getQueue(name);
    if (!existing) {
      await this.boss.createQueue(name, { ...options, ...(deadLetter ? { deadLetter } : {}) });
    } else {
      await this.boss.updateQueue(name, options);
    }
  }

  /** Coloca um job na fila. O payload é validado antes (erro de programação falha aqui, não no worker). */
  async enqueue<D extends QueueDefinition>(
    def: D,
    payload: PayloadInputOf<D>,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const parsed = def.payload.parse(payload) as PayloadOf<D> & { tenantId: string };
    // O pg-boss guarda o id do job numa coluna uuid: avisamos aqui, com o nome do culpado, em vez
    // de deixar o Postgres responder "invalid input syntax for type uuid" no meio da fila.
    if (options.jobId && !isUuid(options.jobId)) {
      throw new Error(
        `jobId precisa ser um UUID (recebi "${options.jobId}"). Use jobIdFor(...) para transformar ` +
          'uma chave de idempotência em UUID.',
      );
    }
    const jobId = await this.boss.send(def.name, parsed, {
      ...(options.jobId ? { id: options.jobId } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    });
    const deduplicated = jobId === null;
    this.metrics.increment(METRIC.enqueued, {
      queue: def.name,
      tenant_id: parsed.tenantId,
      deduplicated: String(deduplicated),
    });
    this.logger.info(
      {
        event: 'queue.enqueued',
        tenant_id: parsed.tenantId,
        queue: def.name,
        job_id: jobId ?? options.jobId,
        deduplicated,
      },
      deduplicated ? 'Job já estava na fila (ignorado)' : 'Job enfileirado',
    );
    return { jobId, deduplicated };
  }

  /** Registra o handler de uma fila. Devolve o id do worker. */
  async work<D extends QueueDefinition>(
    def: D,
    handler: JobHandler<D>,
    options: { concurrency?: number } = {},
  ): Promise<string> {
    return this.boss.work(
      def.name,
      {
        includeMetadata: true,
        perJobResults: true,
        batchSize: 1,
        localConcurrency: options.concurrency ?? def.concurrency,
        pollingIntervalSeconds: this.pollingIntervalSeconds,
      },
      async (jobs) =>
        Promise.all(jobs.map((job) => this.runJob(def, handler, job as unknown as BossJob))),
    );
  }

  private async runJob<D extends QueueDefinition>(
    def: D,
    handler: JobHandler<D>,
    job: BossJob,
  ): Promise<JobResult> {
    const startedAt = performance.now();
    const attempt = job.retryCount + 1;
    const maxAttempts = job.retryLimit + 1;
    const parsed = def.payload.safeParse(job.data);
    const tenantId = parsed.success
      ? (parsed.data as { tenantId: string }).tenantId
      : readTenantId(job.data);
    const base: LogFields = {
      tenant_id: tenantId,
      queue: def.name,
      job_id: job.id,
      attempt,
      max_attempts: maxAttempts,
    };
    const log = bindLogger(this.logger, base);

    const finish = (outcome: JobOutcome, extra: LogFields = {}) => {
      const durationMs = Math.round(performance.now() - startedAt);
      const labels = { queue: def.name, tenant_id: tenantId };
      this.metrics.increment(METRIC.processed, { ...labels, outcome });
      this.metrics.timing(METRIC.duration, durationMs, labels);
      const fields = { event: 'queue.job', outcome, duration_ms: durationMs, ...base, ...extra };
      if (outcome === 'completed') this.logger.info(fields, 'Job concluído');
      else if (outcome === 'retry') this.logger.warn(fields, 'Job falhou; será repetido');
      else this.logger.error(fields, 'Job foi para a fila de falhas (DLQ)');
    };

    if (!parsed.success) {
      const output = { name: 'InvalidPayload', message: parsed.error.message.slice(0, 300) };
      finish('dead_letter', { error: output, reason: 'invalid_payload' });
      return { id: job.id, status: 'deadletter', output };
    }

    try {
      await handler({
        jobId: job.id,
        tenantId,
        payload: parsed.data as PayloadOf<D>,
        attempt,
        maxAttempts,
        signal: job.signal,
        logger: log,
      });
      finish('completed');
      return { id: job.id, status: 'completed' };
    } catch (error) {
      const output = describeError(error);
      if (!isRetryable(error)) {
        finish('dead_letter', { error: output, reason: 'non_retryable' });
        return { id: job.id, status: 'deadletter', output };
      }
      const willRetry = job.retryCount < job.retryLimit;
      finish(willRetry ? 'retry' : 'dead_letter', {
        error: output,
        ...(willRetry ? {} : { reason: 'retries_exhausted' }),
      });
      return { id: job.id, status: 'failed', output };
    }
  }
}

function readTenantId(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'tenantId' in data) {
    const value = (data as { tenantId: unknown }).tenantId;
    if (typeof value === 'string' && value.length <= 64) return value;
  }
  return UNKNOWN_TENANT;
}

/** Logger que acrescenta campos fixos (tenant_id, queue, job_id) a toda linha. */
function bindLogger(logger: QueueLogger, fixed: LogFields): QueueLogger {
  return {
    debug: (fields, message) => logger.debug?.({ ...fixed, ...fields }, message),
    info: (fields, message) => logger.info({ ...fixed, ...fields }, message),
    warn: (fields, message) => logger.warn({ ...fixed, ...fields }, message),
    error: (fields, message) => logger.error({ ...fixed, ...fields }, message),
  };
}
