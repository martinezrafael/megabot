import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { NonRetryableError, QUEUES } from '../src';
import { TENANT_A, TENANT_B, waitFor, withIsolatedQueue } from './helpers';

describe('QueueClient (Postgres real, schema isolado)', () => {
  it('cria as filas e as DLQs com a política definida', async () => {
    await withIsolatedQueue(async ({ client }) => {
      const q = await client.boss.getQueue(QUEUES.whatsappInbound.name);
      assert.equal(q?.deadLetter, 'whatsapp.inbound.dlq');
      assert.equal(q?.retryLimit, QUEUES.whatsappInbound.retry.retryLimit);
      assert.equal(q?.retryBackoff, true);
      assert.ok(await client.boss.getQueue('whatsapp.inbound.dlq'));
    });
  });

  it('start() é repetível (reaplica as opções sem erro)', async () => {
    await withIsolatedQueue(async ({ client }) => {
      await client.ensureQueues();
      await client.ensureQueues();
    });
  });

  it('executa o job e registra log + métricas com tenant_id', async () => {
    await withIsolatedQueue(async ({ client, recorder }) => {
      const seen: string[] = [];
      await client.work(QUEUES.systemPing, async (ctx) => {
        seen.push(`${ctx.tenantId}:${ctx.attempt}/${ctx.maxAttempts}`);
        ctx.logger.info({ event: 'teste.handler' }, 'dentro do handler');
      });
      const { jobId } = await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_A });
      assert.ok(jobId);

      await waitFor(() => recorder.logs.find((l) => l.event === 'queue.job'), {
        what: 'job concluído',
      });
      assert.deepEqual(seen, [`${TENANT_A}:1/3`]);

      const done = recorder.logs.find((l) => l.event === 'queue.job');
      assert.equal(done?.outcome, 'completed');
      assert.equal(done?.tenant_id, TENANT_A);
      assert.equal(done?.queue, 'system.ping');
      assert.equal(done?.job_id, jobId);

      const inHandler = recorder.logs.find((l) => l.event === 'teste.handler');
      assert.equal(inHandler?.tenant_id, TENANT_A, 'logger do handler já traz tenant_id');

      const processed = recorder.metrics.find((m) => m.name === 'queue_jobs_processed_total');
      assert.deepEqual(processed?.labels, {
        queue: 'system.ping',
        tenant_id: TENANT_A,
        outcome: 'completed',
      });
      assert.ok(recorder.metrics.some((m) => m.name === 'queue_job_duration_ms'));
      assert.ok(recorder.metrics.some((m) => m.name === 'queue_jobs_enqueued_total'));
    });
  });

  it('enfileirar com o mesmo jobId é idempotente', async () => {
    await withIsolatedQueue(async ({ client, recorder }) => {
      const jobId = randomUUID();
      const first = await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_A }, { jobId });
      const second = await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_A }, { jobId });
      assert.equal(first.jobId, jobId);
      assert.equal(first.deduplicated, false);
      assert.equal(second.jobId, null);
      assert.equal(second.deduplicated, true);
      const dedup = recorder.metrics.filter(
        (m) => m.name === 'queue_jobs_enqueued_total' && m.labels?.deduplicated === 'true',
      );
      assert.equal(dedup.length, 1);
    });
  });

  it('valida o payload ao enfileirar', async () => {
    await withIsolatedQueue(async ({ client }) => {
      await assert.rejects(() =>
        client.enqueue(QUEUES.whatsappInbound, { tenantId: TENANT_A } as never),
      );
      await assert.rejects(() => client.enqueue(QUEUES.systemPing, { tenantId: 'x' } as never));
    });
  });

  it('repete com backoff e, esgotadas as tentativas, copia o job para a DLQ', async () => {
    // retryLimit 1 e espera de 1 s para o teste ser rápido.
    const fast = {
      ...QUEUES.systemPing,
      retry: { retryLimit: 1, retryDelaySeconds: 1, retryDelayMaxSeconds: 2 },
    };
    await withIsolatedQueue(
      async ({ client, recorder }) => {
        const attempts: number[] = [];
        await client.work(fast, async (ctx) => {
          attempts.push(ctx.attempt);
          throw new Error('falha temporária');
        });
        const { jobId } = await client.enqueue(fast, { tenantId: TENANT_A });

        await waitFor(() => recorder.logs.find((l) => l.outcome === 'dead_letter'), {
          what: 'job na DLQ',
        });
        assert.deepEqual(attempts, [1, 2]);
        const outcomes = recorder.logs.filter((l) => l.event === 'queue.job').map((l) => l.outcome);
        assert.deepEqual(outcomes, ['retry', 'dead_letter']);

        const dlq = await waitFor(
          async () => {
            const jobs = await client.boss.fetch(fast.deadLetterName, { includeMetadata: true });
            return jobs.length ? jobs : null;
          },
          { what: 'job copiado para a DLQ' },
        );
        assert.equal(dlq[0]?.sourceId, jobId);
        assert.equal(dlq[0]?.sourceName, fast.name);
        assert.equal((dlq[0]?.data as { tenantId: string }).tenantId, TENANT_A);
      },
      { queues: [fast] },
    );
  });

  it('erro não repetível vai direto para a DLQ, sem gastar tentativas', async () => {
    await withIsolatedQueue(async ({ client, recorder }) => {
      let calls = 0;
      await client.work(QUEUES.systemPing, async () => {
        calls += 1;
        throw new NonRetryableError('dado inválido');
      });
      await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_B });
      const line = await waitFor(() => recorder.logs.find((l) => l.outcome === 'dead_letter'), {
        what: 'DLQ direta',
      });
      assert.equal(line.reason, 'non_retryable');
      assert.equal(line.tenant_id, TENANT_B);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(calls, 1, 'não pode tentar de novo');
    });
  });

  it('payload inválido (job corrompido) vai para a DLQ sem chamar o handler', async () => {
    await withIsolatedQueue(async ({ client, recorder }) => {
      let called = false;
      await client.work(QUEUES.systemPing, async () => {
        called = true;
      });
      // Enfileira "por fora" do enqueue(), simulando um payload que não passa no schema.
      await client.boss.send(QUEUES.systemPing.name, { tenantId: TENANT_A, simulate: 'voar' });
      const line = await waitFor(() => recorder.logs.find((l) => l.reason === 'invalid_payload'), {
        what: 'payload inválido',
      });
      assert.equal(line.outcome, 'dead_letter');
      assert.equal(line.tenant_id, TENANT_A);
      assert.equal(called, false);
    });
  });

  it('stop() espera o job em andamento terminar (desligamento gracioso)', async () => {
    await withIsolatedQueue(async ({ client, recorder }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started = false;
      await client.work(QUEUES.systemPing, async () => {
        started = true;
        await gate;
      });
      await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_A });
      await waitFor(() => started, { what: 'job iniciado' });

      let stopped = false;
      const stopping = client.stop({ timeoutMs: 10_000 }).then(() => (stopped = true));
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(stopped, false, 'stop() não pode terminar com job ativo');

      release();
      await stopping;
      assert.equal(
        recorder.logs.find((l) => l.event === 'queue.job')?.outcome,
        'completed',
        'o job ativo concluiu antes de desligar',
      );
    });
  });
});
