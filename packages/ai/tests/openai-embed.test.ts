import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiError, OpenAiProvider, type AiUsageRecord } from '../src';
import { apiError, captureLogs, captureMetrics, fakeFetch, json } from './helpers';

const KEY = 'sk-test-CHAVE-SECRETA-123';
const PRICING = { 'emb-x': { inputPerMillion: 0.1, outputPerMillion: 0 } };

const embedOk = (vectors: number[][], over: Record<string, unknown> = {}) =>
  json({
    model: 'emb-x',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    usage: { prompt_tokens: 2_000_000, total_tokens: 2_000_000 },
    ...over,
  });

function make(
  responders: Parameters<typeof fakeFetch>[0],
  extra: Partial<ConstructorParameters<typeof OpenAiProvider>[0]> = {},
) {
  const f = fakeFetch(responders);
  const logs = captureLogs();
  const m = captureMetrics();
  const usage: AiUsageRecord[] = [];
  const provider = new OpenAiProvider({
    apiKey: KEY,
    chatModel: 'c',
    embeddingModel: 'emb-x',
    pricing: PRICING,
    fetch: f.fetch,
    logger: logs.logger,
    metrics: m.metrics,
    onUsage: (r) => void usage.push(r),
    sleep: async () => undefined,
    random: () => 0,
    ...extra,
  });
  return { provider, usage, ...f, ...logs, ...m };
}

describe('OpenAiProvider.embed', () => {
  it('envia o lote e devolve os vetores na ordem de input (mesmo se a API desordenar)', async () => {
    const t = make([
      json({
        model: 'emb-x',
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
        usage: { prompt_tokens: 2_000_000, total_tokens: 2_000_000 },
      }),
    ]);
    const result = await t.provider.embed({ tenantId: 't1', input: ['primeiro', 'segundo'] });

    const call = t.calls[0]!;
    assert.equal(call.url, 'https://api.openai.com/v1/embeddings');
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(call.body, {
      model: 'emb-x',
      input: ['primeiro', 'segundo'],
      encoding_format: 'float',
    });
    assert.deepEqual(result.embeddings, [
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    assert.equal(result.dimensions, 2);
    assert.equal(result.usage.inputTokens, 2_000_000);
    assert.equal(result.costUsd, 0.2);
  });

  it('envia `dimensions` (da requisição ou do padrão) e confere a dimensão devolvida', async () => {
    const t = make([embedOk([[1, 2, 3]])], { embeddingDimensions: 3 });
    const result = await t.provider.embed({ tenantId: 't1', input: ['a'] });
    assert.equal(t.calls[0]!.body.dimensions, 3);
    assert.equal(result.dimensions, 3);

    const t2 = make([embedOk([[1, 2]])]);
    await assert.rejects(
      t2.provider.embed({ tenantId: 't1', input: ['a'], dimensions: 3 }),
      (e: unknown) => e instanceof AiError && e.category === 'invalid_response',
    );
  });

  it('resposta inconsistente (quantidade, índice repetido, dimensões diferentes, vazio) → invalid_response', async () => {
    const bad = [
      embedOk([[1, 2]]), // veio 1 para 2 textos
      json({
        model: 'emb-x',
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [2] },
        ],
        usage: {},
      }),
      embedOk([[1, 2], [3]]),
      embedOk([[], []]),
    ];
    for (const response of bad) {
      const t = make([response]);
      await assert.rejects(
        t.provider.embed({ tenantId: 't1', input: ['a', 'b'] }),
        (e: unknown) => e instanceof AiError && e.category === 'invalid_response' && !e.retryable,
      );
      assert.equal(t.calls.length, 1);
    }
  });

  it('valida o pedido antes de chamar a rede', async () => {
    const t = make([embedOk([[1]])]);
    const bad = [
      { tenantId: '', input: ['a'] },
      { tenantId: 't1', input: [] },
      { tenantId: 't1', input: ['a', '  '] },
      { tenantId: 't1', input: Array.from({ length: 2049 }, () => 'x') },
      { tenantId: 't1', input: ['a'], dimensions: 0 },
    ];
    for (const request of bad) {
      await assert.rejects(
        t.provider.embed(request),
        (e: unknown) => e instanceof AiError && e.category === 'invalid_request',
      );
    }
    assert.equal(t.calls.length, 0);
  });

  it('repete falhas transitórias e não repete as definitivas', async () => {
    const t = make([apiError(500, null), embedOk([[1, 2]])]);
    assert.equal((await t.provider.embed({ tenantId: 't1', input: ['a'] })).dimensions, 2);
    assert.equal(t.calls.length, 2);

    const t2 = make([apiError(401, 'invalid_api_key')]);
    await assert.rejects(
      t2.provider.embed({ tenantId: 't1', input: ['a'] }),
      (e: unknown) => e instanceof AiError && e.category === 'auth',
    );
    assert.equal(t2.calls.length, 1);
  });

  it('log/métricas/uso com tenant_id; nunca o texto nem os vetores', async () => {
    const t = make([embedOk([[0.111111, 0.222222]])]);
    await t.provider.embed({ tenantId: 'tenant-9', input: ['TEXTO-SECRETO-DO-CLIENTE'] });
    const log = t.lines.find((l) => l.fields.event === 'ai.call')!;
    assert.equal(log.fields.tenant_id, 'tenant-9');
    assert.equal(log.fields.operation, 'embed');
    assert.equal(log.fields.input_tokens, 2_000_000);
    const all = JSON.stringify([t.lines, t.increments, t.timings, t.usage]);
    assert.ok(!all.includes('TEXTO-SECRETO-DO-CLIENTE'));
    assert.ok(!all.includes('0.111111'));
    assert.ok(!all.includes(KEY));
    assert.equal(t.usage[0]?.operation, 'embed');
    assert.ok(t.increments.every((i) => i.labels.tenant_id === 'tenant-9'));
  });
});
