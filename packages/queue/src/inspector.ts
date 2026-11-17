import pg from 'pg';
import { PGBOSS_SCHEMA, toPgConnectionString } from './connection';

/**
 * Leitura (somente leitura!) das tabelas do pg-boss para a tela de filas do admin.
 * O pg-boss não traz painel pronto, então consultamos `pgboss.queue` e `pgboss.job` direto.
 *
 * Privacidade: NUNCA devolvemos o `data` do job (payload). Só o `tenantId` e um resumo do erro
 * (nome + mensagem truncada). Quem precisar do payload completo consulta o banco com acesso apropriado.
 *
 * Atenção ao atualizar o pg-boss: os nomes de tabelas/colunas abaixo são do schema da versão 12.
 * O teste de integração (tests/inspector.test.ts) falha se uma atualização mudar o schema.
 */

export const JOB_STATES = [
  'created',
  'retry',
  'active',
  'completed',
  'cancelled',
  'failed',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface QueueOverview {
  name: string;
  /** Verdadeiro para filas `*.dlq` (recebem os jobs que falharam de vez). */
  isDeadLetter: boolean;
  deadLetterName: string | null;
  config: {
    retryLimit: number;
    retryDelaySeconds: number;
    retryBackoff: boolean;
    retryDelayMaxSeconds: number | null;
    expireInSeconds: number;
  };
  counts: Record<JobState, number> & {
    /** Subconjunto de `created`: agendados para o futuro (ainda não prontos). */
    deferred: number;
  };
  /** Há quantos segundos o job pronto mais antigo espera (null = fila sem espera). */
  oldestWaitingSeconds: number | null;
  lastCompletedAt: Date | null;
  lastFailedAt: Date | null;
}

export interface QueuesSnapshot {
  /** false = o worker ainda nunca subiu (schema do pg-boss inexistente). */
  installed: boolean;
  generatedAt: Date;
  queues: QueueOverview[];
}

export interface JobSummary {
  id: string;
  queue: string;
  state: JobState;
  tenantId: string | null;
  retryCount: number;
  retryLimit: number;
  createdAt: Date;
  startAfter: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Só em jobs da DLQ: de qual fila vieram e qual job original falhou. */
  sourceQueue: string | null;
  sourceJobId: string | null;
  errorName: string | null;
  errorMessage: string | null;
}

export interface ListJobsOptions {
  queue: string;
  state?: JobState;
  tenantId?: string;
  /** 1 a 100 (padrão 25). */
  limit?: number;
}

export interface QueueInspectorOptions {
  connectionString: string;
  schema?: string;
  /** Conexões do pool próprio do inspetor (padrão 2). */
  poolSize?: number;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const ERROR_MESSAGE_MAX = 300;

export class QueueInspector {
  private readonly pool: pg.Pool;
  private readonly schema: string;

  constructor(options: QueueInspectorOptions) {
    const schema = options.schema ?? PGBOSS_SCHEMA;
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Schema inválido: "${schema}"`);
    this.schema = schema;
    this.pool = new pg.Pool({
      connectionString: toPgConnectionString(options.connectionString),
      max: options.poolSize ?? 2,
      statement_timeout: 5_000,
      application_name: 'megabot-queue-inspector',
    });
    // Erro em conexão ociosa não pode derrubar o processo.
    this.pool.on('error', () => undefined);
  }

  private closing: Promise<void> | undefined;

  /** Fecha o pool. Seguro chamar mais de uma vez. */
  close(): Promise<void> {
    this.closing ??= this.pool.end();
    return this.closing;
  }

  private async isInstalled(): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS ok',
      [`${this.schema}.job`],
    );
    return rows[0]?.ok === true;
  }

  /** Uma linha por fila (inclusive as DLQs), com a contagem de jobs por estado. */
  async overview(): Promise<QueuesSnapshot> {
    const generatedAt = new Date();
    if (!(await this.isInstalled())) return { installed: false, generatedAt, queues: [] };

    const s = this.schema;
    const { rows } = await this.pool.query<OverviewRow>(
      `SELECT q.name, q.dead_letter, q.retry_limit, q.retry_delay, q.retry_backoff,
              q.retry_delay_max, q.expire_seconds,
              count(*) FILTER (WHERE j.state = 'created')::int   AS created,
              count(*) FILTER (WHERE j.state = 'retry')::int     AS retry,
              count(*) FILTER (WHERE j.state = 'active')::int    AS active,
              count(*) FILTER (WHERE j.state = 'completed')::int AS completed,
              count(*) FILTER (WHERE j.state = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE j.state = 'failed')::int    AS failed,
              count(*) FILTER (WHERE j.state = 'created' AND j.start_after > now())::int AS deferred,
              extract(epoch FROM now() - min(j.start_after)
                FILTER (WHERE j.state IN ('created', 'retry') AND j.start_after <= now()))::float8
                AS oldest_waiting_seconds,
              max(j.completed_on) FILTER (WHERE j.state = 'completed') AS last_completed_at,
              max(j.completed_on) FILTER (WHERE j.state = 'failed')    AS last_failed_at
         FROM ${s}.queue q
         LEFT JOIN ${s}.job j ON j.name = q.name
        GROUP BY q.name
        ORDER BY q.name`,
    );

    return {
      installed: true,
      generatedAt,
      queues: rows.map((r) => ({
        name: r.name,
        isDeadLetter: r.name.endsWith('.dlq'),
        deadLetterName: r.dead_letter,
        config: {
          retryLimit: r.retry_limit,
          retryDelaySeconds: r.retry_delay,
          retryBackoff: r.retry_backoff,
          retryDelayMaxSeconds: r.retry_delay_max,
          expireInSeconds: r.expire_seconds,
        },
        counts: {
          created: r.created,
          retry: r.retry,
          active: r.active,
          completed: r.completed,
          cancelled: r.cancelled,
          failed: r.failed,
          deferred: r.deferred,
        },
        oldestWaitingSeconds:
          r.oldest_waiting_seconds === null
            ? null
            : Math.max(0, Math.round(r.oldest_waiting_seconds)),
        lastCompletedAt: r.last_completed_at,
        lastFailedAt: r.last_failed_at,
      })),
    };
  }

  async queueExists(name: string): Promise<boolean> {
    if (!(await this.isInstalled())) return false;
    const { rows } = await this.pool.query(`SELECT 1 FROM ${this.schema}.queue WHERE name = $1`, [
      name,
    ]);
    return rows.length > 0;
  }

  /** Jobs mais recentes de uma fila (sem o payload). */
  async listJobs(options: ListJobsOptions): Promise<JobSummary[]> {
    if (!(await this.isInstalled())) return [];
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

    const params: unknown[] = [options.queue];
    const where = ['j.name = $1'];
    if (options.state) {
      params.push(options.state);
      where.push(`j.state = $${params.length}::${this.schema}.job_state`);
    }
    if (options.tenantId) {
      params.push(options.tenantId);
      where.push(`j.data->>'tenantId' = $${params.length}`);
    }
    params.push(limit);

    const { rows } = await this.pool.query<JobRow>(
      `SELECT j.id, j.name, j.state::text AS state, j.data->>'tenantId' AS tenant_id,
              j.retry_count, j.retry_limit, j.created_on, j.start_after, j.started_on, j.completed_on,
              j.source_name, j.source_id,
              left(coalesce(j.output, j.source_output)->>'name', 100) AS error_name,
              left(coalesce(j.output, j.source_output)->>'message', ${ERROR_MESSAGE_MAX}) AS error_message
         FROM ${this.schema}.job j
        WHERE ${where.join(' AND ')}
        ORDER BY j.created_on DESC
        LIMIT $${params.length}`,
      params,
    );

    return rows.map((r) => ({
      id: r.id,
      queue: r.name,
      state: r.state,
      tenantId: r.tenant_id,
      retryCount: r.retry_count,
      retryLimit: r.retry_limit,
      createdAt: r.created_on,
      startAfter: r.start_after,
      startedAt: r.started_on,
      completedAt: r.completed_on,
      sourceQueue: r.source_name,
      sourceJobId: r.source_id,
      errorName: r.error_name,
      errorMessage: r.error_message,
    }));
  }
}

interface OverviewRow {
  name: string;
  dead_letter: string | null;
  retry_limit: number;
  retry_delay: number;
  retry_backoff: boolean;
  retry_delay_max: number | null;
  expire_seconds: number;
  created: number;
  retry: number;
  active: number;
  completed: number;
  cancelled: number;
  failed: number;
  deferred: number;
  oldest_waiting_seconds: number | null;
  last_completed_at: Date | null;
  last_failed_at: Date | null;
}

interface JobRow {
  id: string;
  name: string;
  state: JobState;
  tenant_id: string | null;
  retry_count: number;
  retry_limit: number;
  created_on: Date;
  start_after: Date;
  started_on: Date | null;
  completed_on: Date | null;
  source_name: string | null;
  source_id: string | null;
  error_name: string | null;
  error_message: string | null;
}
