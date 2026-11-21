import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_QUEUES, QUEUES, defineQueue, findQueueByName, isUuid, jobIdFor } from '../src';
import { z } from 'zod';

describe('definições das filas', () => {
  it('nomes são únicos e cada fila tem sua DLQ <nome>.dlq', () => {
    const names = ALL_QUEUES.flatMap((q) => [q.name, q.deadLetterName]);
    assert.equal(new Set(names).size, names.length);
    for (const q of ALL_QUEUES) assert.equal(q.deadLetterName, `${q.name}.dlq`);
  });

  it('todo payload exige tenantId (UUID)', () => {
    for (const q of ALL_QUEUES) {
      const shape = (q.payload as unknown as z.ZodObject).shape;
      assert.ok('tenantId' in shape, `${q.name} sem tenantId`);
      const result = q.payload.safeParse({ tenantId: 'nao-e-uuid' });
      assert.equal(result.success, false);
    }
  });

  it('política de retentativa é coerente (espera inicial <= teto, tentativas > 0)', () => {
    for (const q of ALL_QUEUES) {
      assert.ok(q.retry.retryLimit > 0, q.name);
      assert.ok(q.retry.retryDelaySeconds <= q.retry.retryDelayMaxSeconds, q.name);
      assert.ok(q.expireInSeconds >= 1, q.name);
      assert.ok(q.concurrency >= 1, q.name);
    }
  });

  it('system.ping aplica o padrão simulate=ok', () => {
    const parsed = QUEUES.systemPing.payload.parse({
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal((parsed as { simulate: string }).simulate, 'ok');
  });

  it('rejeita nome de fila inválido', () => {
    assert.throws(() =>
      defineQueue({
        name: 'nome com espaço',
        description: 'x',
        payload: z.object({}),
        retry: { retryLimit: 1, retryDelaySeconds: 1, retryDelayMaxSeconds: 1 },
        expireInSeconds: 1,
        concurrency: 1,
        keepCompletedSeconds: 1,
      }),
    );
  });

  it('findQueueByName acha pela fila e pela DLQ', () => {
    assert.equal(findQueueByName('whatsapp.inbound')?.name, 'whatsapp.inbound');
    assert.equal(findQueueByName('whatsapp.inbound.dlq')?.name, 'whatsapp.inbound');
    assert.equal(findQueueByName('nao.existe'), undefined);
  });
});

describe('jobIdFor (chave de idempotência -> UUID)', () => {
  it('é determinístico e tem forma de UUID', () => {
    const a = jobIdFor('knowledge-full', 'fonte-1', 1795218679850);
    assert.equal(a, jobIdFor('knowledge-full', 'fonte-1', 1795218679850));
    assert.ok(isUuid(a), a);
    // Versão 5 e variante RFC 4122.
    assert.equal(a[14], '5');
    assert.ok(['8', '9', 'a', 'b'].includes(a[19]!));
  });

  it('entradas diferentes dão UUIDs diferentes (inclusive só mudando a ordem)', () => {
    const base = jobIdFor('knowledge-full', 'fonte-1', 1);
    assert.notEqual(base, jobIdFor('knowledge-full', 'fonte-1', 2));
    assert.notEqual(base, jobIdFor('knowledge-stale', 'fonte-1', 1));
    assert.notEqual(jobIdFor('a', 'b'), jobIdFor('ab'));
  });

  it('isUuid aceita UUID e recusa o resto', () => {
    assert.equal(isUuid('9bce8270-cc29-4473-8569-2c37531ffc75'), true);
    assert.equal(isUuid('9bce8270-cc29-4473-8569-2c37531ffc75-1795218679850'), false);
    assert.equal(isUuid('nao-e-uuid'), false);
    assert.equal(isUuid(''), false);
  });
});
