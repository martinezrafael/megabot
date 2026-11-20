import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';
import { AiError, OpenAiProvider, defineTool } from '../src';

/**
 * Contra um servidor HTTP REAL local (sem mocks de fetch): confere `fetch`, cabeçalhos, timeout por
 * AbortSignal, cancelamento e retentativa com Retry-After de verdade.
 */
describe('OpenAiProvider contra um servidor HTTP local', () => {
  let server: http.Server;
  let baseUrl = '';
  const seen: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
  let mode: 'ok' | 'flaky' | 'slow' | 'tools' = 'ok';
  let hits = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        hits += 1;
        seen.push({
          url: req.url ?? '',
          auth: req.headers.authorization,
          body: JSON.parse(raw || '{}') as Record<string, unknown>,
        });
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-request-id', `req_${hits}`);
        if (mode === 'slow') return; // nunca responde: o cliente tem de estourar o tempo
        if (mode === 'flaky' && hits === 1) {
          res.statusCode = 429;
          res.setHeader('retry-after', '0');
          return void res.end(
            JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'x' } }),
          );
        }
        if (req.url === '/v1/embeddings') {
          return void res.end(
            JSON.stringify({
              model: 'emb-x',
              data: [{ index: 0, embedding: [0.5, 0.5] }],
              usage: { prompt_tokens: 3, total_tokens: 3 },
            }),
          );
        }
        const message =
          mode === 'tools'
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'buscar', arguments: '{"termo":"oi"}' },
                  },
                ],
              }
            : { role: 'assistant', content: 'pong' };
        res.end(
          JSON.stringify({
            model: 'm',
            choices: [{ finish_reason: mode === 'tools' ? 'tool_calls' : 'stop', message }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const provider = (over: Partial<ConstructorParameters<typeof OpenAiProvider>[0]> = {}) =>
    new OpenAiProvider({
      apiKey: 'sk-local',
      chatModel: 'm',
      embeddingModel: 'emb-x',
      baseUrl,
      retryBaseDelayMs: 5,
      ...over,
    });
  const reset = (m: typeof mode) => {
    mode = m;
    hits = 0;
    seen.length = 0;
  };

  it('chat e embeddings de ponta a ponta', async () => {
    reset('ok');
    const p = provider();
    const chat = await p.generate({ tenantId: 't', messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(chat.text, 'pong');
    assert.equal(chat.requestId, 'req_1');
    assert.equal(seen[0]?.auth, 'Bearer sk-local');
    const emb = await p.embed({ tenantId: 't', input: ['oi'] });
    assert.deepEqual(emb.embeddings, [[0.5, 0.5]]);
    assert.equal(seen[1]?.url, '/v1/embeddings');
  });

  it('tool calling de ponta a ponta', async () => {
    reset('tools');
    const buscar = defineTool({
      name: 'buscar',
      description: 'b',
      parameters: z.object({ termo: z.string() }),
    });
    const result = await provider().generate({
      tenantId: 't',
      messages: [{ role: 'user', content: 'oi' }],
      tools: [buscar] as const,
    });
    assert.equal(result.toolCalls[0]?.arguments.termo, 'oi');
  });

  it('429 com Retry-After: repete de verdade e conclui', async () => {
    reset('flaky');
    const result = await provider().generate({
      tenantId: 't',
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(result.text, 'pong');
    assert.equal(hits, 2);
  });

  it('servidor que não responde: estoura o timeout (category timeout) e respeita maxRetries', async () => {
    reset('slow');
    const started = Date.now();
    await assert.rejects(
      provider({ timeoutMs: 150, maxRetries: 1 }).generate({
        tenantId: 't',
        messages: [{ role: 'user', content: 'x' }],
      }),
      (e: unknown) => e instanceof AiError && e.category === 'timeout' && e.attempts === 2,
    );
    assert.equal(hits, 2);
    assert.ok(Date.now() - started < 3000);
  });

  it('cancelamento pelo chamador interrompe a espera', async () => {
    reset('slow');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      provider({ timeoutMs: 10_000 }).generate({
        tenantId: 't',
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
      }),
      (e: unknown) => e instanceof AiError && e.category === 'aborted',
    );
    assert.equal(hits, 1);
  });

  it('servidor inacessível: erro de rede transitório', async () => {
    await assert.rejects(
      provider({ baseUrl: 'http://127.0.0.1:1', maxRetries: 1 }).generate({
        tenantId: 't',
        messages: [{ role: 'user', content: 'x' }],
      }),
      (e: unknown) =>
        e instanceof AiError && e.category === 'temporary' && e.retryable && e.attempts === 2,
    );
  });
});
