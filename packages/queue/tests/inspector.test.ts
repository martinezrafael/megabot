import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NonRetryableError, QUEUES, QueueInspector } from '../src';
import { DATABASE_URL, TENANT_A, TENANT_B, waitFor, withIsolatedQueue } from './helpers';

describe('QueueInspector (lê as tabelas do pg-boss)', () => {
  it('schema ainda não instalado: installed=false, sem erro', async () => {
    const inspector = new QueueInspector({
      connectionString: DATABASE_URL,
      schema: 'pgboss_nunca_criado',
    });
    try {
      const snapshot = await inspector.overview();
      assert.equal(snapshot.installed, false);
      assert.deepEqual(snapshot.queues, []);
      assert.deepEqual(await inspector.listJobs({ queue: 'x' }), []);
      assert.equal(await inspector.queueExists('x'), false);
    } finally {
      await inspector.close();
    }
  });

  it('rejeita schema com caracteres perigosos', () => {
    assert.throws(
      () => new QueueInspector({ connectionString: DATABASE_URL, schema: 'x; DROP TABLE users' }),
    );
  });

  it('conta jobs por estado, lista DLQ e nunca expõe o payload', async () => {
    await withIsolatedQueue(async ({ client, schema, recorder }) => {
      await client.work(QUEUES.systemPing, async (ctx) => {
        if (ctx.payload.simulate === 'fatal-failure') {
          throw new NonRetryableError('Falha simulada com segredo-no-erro?');
        }
      });
      await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_A });
      await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_B, simulate: 'fatal-failure' });
      // Agendado para o futuro: fica em "created" e conta como deferred.
      await client.enqueue(QUEUES.systemPing, { tenantId: TENANT_A }, { startAfterSeconds: 3600 });
      // Fila sem worker: acumula "waiting".
      await client.enqueue(QUEUES.whatsappInbound, {
        tenantId: TENANT_A,
        webhookEventId: '33333333-3333-4333-8333-333333333333',
      });

      await waitFor(() => recorder.logs.filter((l) => l.event === 'queue.job').length >= 2, {
        what: 'dois jobs processados',
      });

      const inspector = new QueueInspector({ connectionString: DATABASE_URL, schema });
      try {
        const snapshot = await waitFor(
          async () => {
            const s = await inspector.overview();
            const dlq = s.queues.find((q) => q.name === 'system.ping.dlq');
            return dlq && dlq.counts.created === 1 ? s : null;
          },
          { what: 'job aparecer na DLQ' },
        );
        assert.equal(snapshot.installed, true);

        const byName = Object.fromEntries(snapshot.queues.map((q) => [q.name, q]));
        const ping = byName['system.ping']!;
        assert.equal(ping.counts.completed, 1);
        assert.equal(ping.counts.failed, 1);
        assert.equal(ping.counts.deferred, 1);
        assert.equal(ping.isDeadLetter, false);
        assert.equal(ping.deadLetterName, 'system.ping.dlq');
        assert.equal(ping.config.retryLimit, QUEUES.systemPing.retry.retryLimit);
        assert.equal(ping.config.retryBackoff, true);
        assert.ok(ping.lastCompletedAt instanceof Date);

        assert.equal(byName['system.ping.dlq']!.isDeadLetter, true);
        assert.equal(byName['whatsapp.inbound']!.counts.created, 1);
        assert.ok((byName['whatsapp.inbound']!.oldestWaitingSeconds ?? -1) >= 0);
        assert.equal(byName['llm.reply']!.counts.created, 0);

        // Falhas na fila original
        const failed = await inspector.listJobs({ queue: 'system.ping', state: 'failed' });
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.tenantId, TENANT_B);
        assert.equal(failed[0]!.errorName, 'NonRetryableError');

        // Job na DLQ aponta para a origem
        const dlqJobs = await inspector.listJobs({ queue: 'system.ping.dlq' });
        assert.equal(dlqJobs.length, 1);
        assert.equal(dlqJobs[0]!.sourceQueue, 'system.ping');
        assert.equal(dlqJobs[0]!.sourceJobId, failed[0]!.id);
        assert.match(dlqJobs[0]!.errorMessage ?? '', /Falha simulada/);

        // Filtro por tenant
        const onlyA = await inspector.listJobs({ queue: 'system.ping', tenantId: TENANT_A });
        assert.ok(onlyA.length >= 2 && onlyA.every((j) => j.tenantId === TENANT_A));

        // Privacidade: nenhum campo do payload (além do tenantId) aparece na resposta
        assert.equal(JSON.stringify(failed).includes('simulate'), false);
        assert.equal(JSON.stringify(dlqJobs).includes('fatal-failure'), false);

        // limit é limitado a 1..100
        assert.equal((await inspector.listJobs({ queue: 'system.ping', limit: 1 })).length, 1);
        assert.ok((await inspector.listJobs({ queue: 'system.ping', limit: 99999 })).length <= 100);
        assert.equal(await inspector.queueExists('system.ping'), true);
        assert.equal(await inspector.queueExists('nao.existe'), false);
      } finally {
        await inspector.close();
      }
    });
  });
});
