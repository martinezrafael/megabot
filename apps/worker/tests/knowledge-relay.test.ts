import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createKnowledgeSource,
  getKnowledgeSource,
  finishKnowledgeSourceIngestion,
  KNOWLEDGE_EMBEDDING_DIMENSIONS as DIMS,
  listKnowledgeChunks,
  replaceKnowledgeChunks,
  requestKnowledgeIngestion,
  updateKnowledgeChunkContent,
} from '@megabot/database';
import { QUEUES, isUuid, jobIdFor } from '@megabot/queue';
import { startKnowledgeRelay } from '../src/knowledge-relay';
import { captureLogger, cleanupTenants, newTenant } from './helpers';

const vector = (seed: number) => {
  const raw = Array.from({ length: DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1)));
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
};

/** Fila de mentira: guarda o que foi enfileirado e finge a deduplicação por jobId do pg-boss. */
function fakeQueue() {
  const seen = new Set<string>();
  const jobs: Array<{ queue: string; payload: Record<string, unknown>; jobId: string }> = [];
  return {
    jobs,
    client: {
      enqueue: async (
        queue: { name: string },
        payload: Record<string, unknown>,
        options?: { jobId?: string },
      ) => {
        const jobId = options?.jobId ?? randomUUID();
        // O pg-boss guarda o id numa coluna uuid: a fila de mentira cobra o mesmo.
        if (!isUuid(jobId)) throw new Error(`jobId precisa ser UUID: ${jobId}`);
        if (seen.has(jobId)) return { jobId, deduplicated: true };
        seen.add(jobId);
        jobs.push({ queue: queue.name, payload, jobId });
        return { jobId, deduplicated: false };
      },
    },
  };
}

describe('relay da base de conhecimento (T2.2)', () => {
  let tenantId = '';

  const currentUpdatedAt = async (sourceId: string) =>
    (await getKnowledgeSource(tenantId, sourceId))!.updatedAt;

  before(async () => {
    ({ tenantId } = await newTenant({ whatsapp: false }));
  });
  after(cleanupTenants);

  const relayFor = (queue: ReturnType<typeof fakeQueue>, cap = captureLogger()) => ({
    relay: startKnowledgeRelay({
      client: queue.client as never,
      logger: cap.logger as never,
      intervalMs: 60_000,
      onlyTenantIds: [tenantId],
    }),
    logs: cap.logs,
  });

  it('enfileira fontes pendentes uma única vez, com jobId estável', async () => {
    const queue = fakeQueue();
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Pendente',
      rawText: 'texto',
    });
    const { relay, logs } = relayFor(queue);
    try {
      await relay.tick();
      assert.equal(await relay.tick(), 0, 'segunda varredura não deve duplicar');
    } finally {
      relay.stop();
    }

    const mine = queue.jobs.filter((job) => job.payload.sourceId === source.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.queue, QUEUES.knowledgeIngest.name);
    assert.deepEqual(mine[0]!.payload, { tenantId, sourceId: source.id, mode: 'full' });
    assert.ok(isUuid(mine[0]!.jobId));
    assert.equal(
      mine[0]!.jobId,
      jobIdFor('knowledge-full', source.id, (await currentUpdatedAt(source.id)).getTime()),
    );
    assert.ok(
      logs.some(
        (l) =>
          l.event === 'knowledge_relay.enqueued' &&
          l.tenant_id === tenantId &&
          l.source_id === source.id,
      ),
    );
  });

  it('um novo pedido de ingestão gera um job novo (jobId diferente)', async () => {
    const queue = fakeQueue();
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Reingestão',
      rawText: 'texto',
    });
    const { relay } = relayFor(queue);
    try {
      await relay.tick();
      const firstJobId = queue.jobs.find((j) => j.payload.sourceId === source.id)!.jobId;

      // Pedido novo (o botão "processar de novo" da tela) muda o updatedAt.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await requestKnowledgeIngestion(tenantId, source.id);
      await relay.tick();

      const mine = queue.jobs.filter((j) => j.payload.sourceId === source.id);
      assert.equal(mine.length, 2);
      assert.notEqual(mine[1]!.jobId, firstJobId);
    } finally {
      relay.stop();
    }
  });

  it('fonte já processada não é enfileirada; trecho editado gera job no modo stale', async () => {
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Pronta',
      rawText: 'texto',
    });
    await replaceKnowledgeChunks(
      tenantId,
      source.id,
      [
        { position: 0, content: 'primeiro', embedding: vector(1) },
        { position: 1, content: 'segundo', embedding: vector(2) },
      ],
      'modelo',
    );
    await finishKnowledgeSourceIngestion(tenantId, source.id, {
      checksum: 'c',
      charCount: 10,
      chunkCount: 2,
      embeddingModel: 'modelo',
      embeddingDimensions: DIMS,
    });

    const queue = fakeQueue();
    const { relay } = relayFor(queue);
    try {
      await relay.tick();
      assert.equal(
        queue.jobs.filter((j) => j.payload.sourceId === source.id).length,
        0,
        'fonte pronta e sem edição não precisa de job',
      );

      const [chunk] = await listKnowledgeChunks(tenantId, source.id);
      await updateKnowledgeChunkContent(tenantId, chunk!.id, 'texto corrigido à mão');
      await relay.tick();

      const stale = queue.jobs.filter((j) => j.payload.sourceId === source.id);
      assert.equal(stale.length, 1);
      assert.deepEqual(stale[0]!.payload, { tenantId, sourceId: source.id, mode: 'stale' });
      assert.ok(isUuid(stale[0]!.jobId));

      // Enquanto o trecho continuar pendente, não duplica o job.
      assert.equal(await relay.tick(), 0);
    } finally {
      relay.stop();
    }
  });

  it('falha ao enfileirar é registrada e não derruba a varredura', async () => {
    await createKnowledgeSource(tenantId, { kind: 'text', title: 'Falha', rawText: 'x' });
    const cap = captureLogger();
    const relay = startKnowledgeRelay({
      client: {
        enqueue: async () => {
          throw new Error('fila fora do ar');
        },
      } as never,
      logger: cap.logger as never,
      intervalMs: 60_000,
      onlyTenantIds: [tenantId],
    });
    try {
      assert.equal(await relay.tick(), 0);
      assert.ok(cap.logs.some((l) => l.event === 'knowledge_relay.failed'));
    } finally {
      relay.stop();
    }
  });
});
