import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { AiError, OpenAiProvider, defineTool, type AiUsageRecord } from '../src';
import { apiError, captureLogs, captureMetrics, chatOk, fakeFetch, hang, json } from './helpers';

const KEY = 'sk-test-CHAVE-SECRETA-123';
const TENANT = 'tenant-1';
const PRICING = {
  'modelo-x': { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
};
const messages = [
  { role: 'system', content: 'Você é um atendente.' },
  { role: 'user', content: 'MENSAGEM-SECRETA-DO-CLIENTE' },
] as const;

function make(
  responders: Parameters<typeof fakeFetch>[0],
  extra: Partial<ConstructorParameters<typeof OpenAiProvider>[0]> = {},
) {
  const f = fakeFetch(responders);
  const logs = captureLogs();
  const m = captureMetrics();
  const sleeps: number[] = [];
  const usage: AiUsageRecord[] = [];
  const provider = new OpenAiProvider({
    apiKey: KEY,
    chatModel: 'modelo-x',
    embeddingModel: 'emb-x',
    pricing: PRICING,
    fetch: f.fetch,
    logger: logs.logger,
    metrics: m.metrics,
    onUsage: (r) => void usage.push(r),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...extra,
  });
  return { provider, sleeps, usage, ...f, ...logs, ...m };
}

const buscar = defineTool({
  name: 'buscar_produto',
  description: 'Busca no catálogo',
  parameters: z.object({ termo: z.string() }),
});

describe('OpenAiProvider.generate — requisição e resposta', () => {
  it('monta a chamada (URL, autenticação, modelo, mensagens) e devolve texto, uso e custo', async () => {
    const t = make([
      chatOk({}, { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000 }),
    ]);
    const result = await t.provider.generate({
      tenantId: TENANT,
      messages,
      temperature: 0.2,
      maxOutputTokens: 300,
    });

    const call = t.calls[0]!;
    assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.body.model, 'modelo-x');
    assert.equal(call.body.temperature, 0.2);
    assert.equal(call.body.max_completion_tokens, 300);
    assert.deepEqual(call.body.messages, [
      { role: 'system', content: 'Você é um atendente.' },
      { role: 'user', content: 'MENSAGEM-SECRETA-DO-CLIENTE' },
    ]);
    assert.ok(!('tools' in call.body));

    assert.equal(result.text, 'Olá!');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.model, 'modelo-x-2026-01-01');
    assert.equal(result.requestId, 'req_abc');
    assert.deepEqual(result.usage, {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 500_000,
      totalTokens: 1_500_000,
    });
    // O modelo respondeu com nome versionado: o preço é achado pelo prefixo.
    assert.equal(result.costUsd, 2 + 4);
  });

  it('o modelo e os parâmetros podem ser trocados por chamada; baseUrl é configurável', async () => {
    const t = make([chatOk()], { baseUrl: 'http://localhost:9999/' });
    await t.provider.generate({ tenantId: TENANT, messages, model: 'outro-modelo' });
    assert.equal(t.calls[0]!.url, 'http://localhost:9999/v1/chat/completions');
    assert.equal(t.calls[0]!.body.model, 'outro-modelo');
  });

  it('desconta os tokens em cache no custo', async () => {
    const t = make([
      chatOk(
        {},
        {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 600_000 },
        },
      ),
    ]);
    const result = await t.provider.generate({ tenantId: TENANT, messages });
    assert.equal(result.usage.cachedInputTokens, 600_000);
    assert.equal(result.costUsd, 0.4 * 2 + 0.6 * 0.5);
  });

  it('modelo sem preço configurado → costUsd null (não inventa valor)', async () => {
    const t = make([chatOk()], { pricing: {} });
    assert.equal((await t.provider.generate({ tenantId: TENANT, messages })).costUsd, null);
  });

  it('mapeia finish_reason', async () => {
    const reasons: Array<[string, string]> = [
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['stop', 'stop'],
      ['algo_novo', 'other'],
    ];
    for (const [raw, expected] of reasons) {
      const t = make([
        chatOk({ choices: [{ finish_reason: raw, message: { role: 'assistant', content: 'x' } }] }),
      ]);
      assert.equal(
        (await t.provider.generate({ tenantId: TENANT, messages })).finishReason,
        expected,
      );
    }
  });
});

describe('OpenAiProvider.generate — tool calling', () => {
  const toolResponse = (args: string, name = 'buscar_produto') =>
    chatOk({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
          },
        },
      ],
    });

  it('envia as ferramentas como JSON Schema e devolve a chamada validada e tipada', async () => {
    const t = make([toolResponse('{"termo":"camiseta"}')]);
    const result = await t.provider.generate({
      tenantId: TENANT,
      messages,
      tools: [buscar] as const,
      toolChoice: { name: 'buscar_produto' },
    });
    const sent = t.calls[0]!.body;
    const tool = (sent.tools as Array<{ type: string; function: Record<string, unknown> }>)[0]!;
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, 'buscar_produto');
    assert.equal((tool.function.parameters as { type: string }).type, 'object');
    assert.deepEqual(sent.tool_choice, { type: 'function', function: { name: 'buscar_produto' } });

    assert.equal(result.text, null);
    assert.equal(result.finishReason, 'tool_calls');
    const call = result.toolCalls[0]!;
    assert.equal(call.name, 'buscar_produto');
    const termo: string = call.arguments.termo; // tipado
    assert.equal(termo, 'camiseta');
  });

  it('reenvia o histórico com a chamada do assistente e o resultado da ferramenta', async () => {
    const t = make([chatOk()]);
    await t.provider.generate({
      tenantId: TENANT,
      tools: [buscar] as const,
      toolChoice: 'auto',
      messages: [
        { role: 'user', content: 'quero camiseta' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call_1', name: 'buscar_produto', arguments: { termo: 'camiseta' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '[{"nome":"Camiseta"}]' },
      ],
    });
    const sent = t.calls[0]!.body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(sent[1], {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'buscar_produto', arguments: '{"termo":"camiseta"}' },
        },
      ],
    });
    assert.deepEqual(sent[2], {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '[{"nome":"Camiseta"}]',
    });
    assert.equal(t.calls[0]!.body.tool_choice, 'auto');
  });

  it('ferramenta desconhecida ou argumentos inválidos: invalid_response, sem repetir, e o consumo É registrado', async () => {
    for (const response of [
      toolResponse('{}', 'apagar_tudo'),
      toolResponse('{"termo":42}'),
      toolResponse('{quebrado'),
    ]) {
      const t = make([response]);
      await assert.rejects(
        t.provider.generate({ tenantId: TENANT, messages, tools: [buscar] as const }),
        (e: unknown) => {
          assert.ok(e instanceof AiError);
          assert.equal(e.category, 'invalid_response');
          assert.equal(e.retryable, false);
          return true;
        },
      );
      assert.equal(t.calls.length, 1, 'não repete: gastaria tokens de novo');
      assert.equal(t.usage[0]?.outcome, 'error');
      assert.equal(t.usage[0]?.usage.inputTokens, 1000, 'tokens gastos aparecem mesmo na falha');
      assert.ok((t.usage[0]?.costUsd ?? 0) > 0);
    }
  });

  it('valida o pedido antes de chamar a rede', async () => {
    const t = make([chatOk()]);
    const bad: Array<Parameters<typeof t.provider.generate>[0]> = [
      { tenantId: '', messages },
      { tenantId: TENANT, messages: [] },
      { tenantId: TENANT, messages, temperature: 3 },
      { tenantId: TENANT, messages, maxOutputTokens: 0 },
      { tenantId: TENANT, messages, toolChoice: 'required' },
      { tenantId: TENANT, messages, tools: [buscar, buscar] as const },
    ];
    for (const request of bad) {
      await assert.rejects(
        t.provider.generate(request),
        (e: unknown) => e instanceof AiError && e.category === 'invalid_request',
      );
    }
    await assert.rejects(
      t.provider.generate({
        tenantId: TENANT,
        messages,
        tools: [buscar] as const,
        // @ts-expect-error nome fora das ferramentas declaradas (o tipo já barra)
        toolChoice: { name: 'outra' },
      }),
      /não declarada/,
    );
    assert.equal(t.calls.length, 0);
    assert.equal(t.usage.length, 0);
  });
});

describe('OpenAiProvider.generate — erros, timeout e retentativa', () => {
  const ask = (t: ReturnType<typeof make>) => t.provider.generate({ tenantId: TENANT, messages });

  it('429 transitório: repete com backoff e dá certo', async () => {
    const t = make([apiError(429, 'rate_limit_exceeded'), chatOk()]);
    const result = await ask(t);
    assert.equal(result.text, 'Olá!');
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.sleeps, [250]); // random 0.5 * min(8000, 500 * 2^0)
    assert.equal(t.usage[0]?.attempts, 2);
    assert.equal(t.usage[0]?.outcome, 'ok');
    assert.equal(t.increments.filter((i) => i.name === 'ai_retries_total').length, 1);
  });

  it('5xx persistente: desiste após 1 + maxRetries chamadas e informa as tentativas', async () => {
    const t = make([apiError(503, null)]);
    await assert.rejects(ask(t), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.category, 'temporary');
      assert.equal(e.retryable, true);
      assert.equal(e.attempts, 3);
      return true;
    });
    assert.equal(t.calls.length, 3);
    assert.deepEqual(t.sleeps, [250, 500]);
  });

  it('maxRetries=0 desliga as repetições internas', async () => {
    const t = make([apiError(500, null)], { maxRetries: 0 });
    await assert.rejects(ask(t), AiError);
    assert.equal(t.calls.length, 1);
    assert.deepEqual(t.sleeps, []);
  });

  it('erros definitivos não repetem (401, 400, cota, contexto)', async () => {
    const cases: Array<[Response, string]> = [
      [apiError(401, 'invalid_api_key'), 'auth'],
      [apiError(400, null), 'invalid_request'],
      [apiError(429, 'insufficient_quota'), 'quota'],
      [apiError(400, 'context_length_exceeded'), 'context_length'],
    ];
    for (const [response, category] of cases) {
      const t = make([response]);
      await assert.rejects(
        ask(t),
        (e: unknown) => e instanceof AiError && e.category === category && !e.retryable,
      );
      assert.equal(t.calls.length, 1);
      assert.deepEqual(t.sleeps, []);
    }
  });

  it('respeita Retry-After curto (espera exatamente o pedido)', async () => {
    const t = make([apiError(429, 'rate_limit_exceeded', 'x', { 'retry-after': '2' }), chatOk()]);
    await ask(t);
    assert.deepEqual(t.sleeps, [2000]);
  });

  it('Retry-After maior que o limite: não segura o worker, devolve retryAfterMs ao job', async () => {
    const t = make([apiError(429, 'rate_limit_exceeded', 'x', { 'retry-after': '120' }), chatOk()]);
    await assert.rejects(ask(t), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.category, 'rate_limit');
      assert.equal(e.retryable, true);
      assert.equal(e.retryAfterMs, 120_000);
      return true;
    });
    assert.equal(t.calls.length, 1);
    assert.deepEqual(t.sleeps, []);
  });

  it('erro de rede é transitório e repetido', async () => {
    const t = make([new TypeError('fetch failed'), chatOk()]);
    assert.equal((await ask(t)).text, 'Olá!');
    assert.equal(t.calls.length, 2);
  });

  it('timeout por tentativa: category timeout, retryable, e repete', async () => {
    const t = make([hang, chatOk()], { timeoutMs: 30 });
    assert.equal((await ask(t)).text, 'Olá!');
    assert.equal(t.calls.length, 2);

    const t2 = make([hang], { timeoutMs: 20, maxRetries: 1 });
    await assert.rejects(ask(t2), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.category, 'timeout');
      assert.equal(e.retryable, true);
      assert.equal(e.attempts, 2);
      return true;
    });
  });

  it('cancelamento pelo chamador: aborted, sem repetir', async () => {
    const controller = new AbortController();
    const t = make([hang]);
    const pending = t.provider.generate({ tenantId: TENANT, messages, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      pending,
      (e: unknown) => e instanceof AiError && e.category === 'aborted' && !e.retryable,
    );
    assert.equal(t.calls.length, 1);
  });

  it('resposta 200 fora do formato (não-JSON ou sem choices): invalid_response, sem repetir', async () => {
    for (const response of [
      new Response('<html>oops</html>', { status: 200 }),
      json({ model: 'm', choices: [] }),
      json({}),
    ]) {
      const t = make([response]);
      await assert.rejects(
        ask(t),
        (e: unknown) => e instanceof AiError && e.category === 'invalid_response' && !e.retryable,
      );
      assert.equal(t.calls.length, 1);
    }
  });

  it('5xx com corpo não-JSON (gateway) também é transitório', async () => {
    const t = make([new Response('<html>Bad Gateway</html>', { status: 502 }), chatOk()]);
    assert.equal((await ask(t)).text, 'Olá!');
  });
});

describe('OpenAiProvider — logs, métricas e registro de uso', () => {
  it('sucesso: log/métricas/uso com tenant_id e sem conteúdo nem chave', async () => {
    const t = make([
      chatOk(
        {},
        {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      ),
    ]);
    await t.provider.generate({ tenantId: TENANT, messages });

    const log = t.lines.find((l) => l.fields.event === 'ai.call')!;
    assert.equal(log.level, 'info');
    assert.equal(log.fields.tenant_id, TENANT);
    assert.equal(log.fields.input_tokens, 1000);
    assert.equal(log.fields.cached_input_tokens, 200);
    assert.equal(log.fields.output_tokens, 500);
    assert.equal(typeof log.fields.cost_usd, 'number');
    assert.equal(log.fields.request_id, 'req_abc');

    const all = JSON.stringify([t.lines, t.increments, t.timings, t.usage]);
    assert.ok(!all.includes(KEY), 'a chave vazou');
    assert.ok(!all.includes('MENSAGEM-SECRETA-DO-CLIENTE'), 'o conteúdo vazou');
    assert.ok(!all.includes('Olá!'), 'a resposta vazou');

    const tokenMetrics = t.increments.filter((i) => i.name === 'ai_tokens_total');
    assert.deepEqual(
      tokenMetrics.map((m) => [m.labels.kind, m.value]),
      [
        ['input', 800],
        ['cached_input', 200],
        ['output', 500],
      ],
    );
    assert.ok(tokenMetrics.every((m) => m.labels.tenant_id === TENANT && m.labels.model));
    assert.ok(
      t.increments.some((i) => i.name === 'ai_cost_usd_total' && i.labels.tenant_id === TENANT),
    );
    assert.ok(
      t.increments.some((i) => i.name === 'ai_requests_total' && i.labels.outcome === 'ok'),
    );
    assert.ok(t.timings.every((m) => m.labels.tenant_id === TENANT));

    assert.deepEqual(t.usage[0], {
      tenantId: TENANT,
      provider: 'openai',
      model: 'modelo-x-2026-01-01',
      operation: 'generate',
      outcome: 'ok',
      usage: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500, totalTokens: 1500 },
      costUsd: t.usage[0]!.costUsd,
      latencyMs: t.usage[0]!.latencyMs,
      attempts: 1,
      requestId: 'req_abc',
    });
  });

  it('erro: log com categoria e código, SEM a mensagem do provedor (pode ecoar o prompt)', async () => {
    const t = make([apiError(400, 'bad_thing', 'Invalid content: MENSAGEM-SECRETA-DO-CLIENTE')]);
    await assert.rejects(t.provider.generate({ tenantId: TENANT, messages }), AiError);
    const log = t.lines.find((l) => l.fields.event === 'ai.call')!;
    assert.equal(log.level, 'error');
    assert.equal(log.fields.tenant_id, TENANT);
    assert.equal(log.fields.error_category, 'invalid_request');
    assert.equal(log.fields.http_status, 400);
    assert.equal(log.fields.provider_code, 'bad_thing');
    assert.ok(
      !JSON.stringify([t.lines, t.increments, t.usage]).includes('MENSAGEM-SECRETA-DO-CLIENTE'),
    );
    assert.equal(t.usage[0]?.outcome, 'error');
    assert.equal(t.usage[0]?.errorCategory, 'invalid_request');
    assert.ok(
      t.increments.some(
        (i) =>
          i.name === 'ai_requests_total' &&
          i.labels.outcome === 'error' &&
          i.labels.error_category === 'invalid_request',
      ),
    );
  });

  it('falha no registro de uso não derruba a chamada (e é logada sem dados sensíveis)', async () => {
    const t = make([chatOk()], {
      onUsage: () => {
        throw new Error('banco fora do ar');
      },
    });
    assert.equal((await t.provider.generate({ tenantId: TENANT, messages })).text, 'Olá!');
    assert.ok(
      t.lines.some(
        (l) => l.fields.event === 'ai.usage_recorder_failed' && l.fields.tenant_id === TENANT,
      ),
    );
  });

  it('provedor sem `usage`: resultado ok, custo null e aviso', async () => {
    const t = make([chatOk({}, null)]);
    const result = await t.provider.generate({ tenantId: TENANT, messages });
    assert.equal(result.costUsd, null);
    assert.equal(result.usage.totalTokens, 0);
    assert.ok(t.lines.some((l) => l.fields.event === 'ai.usage_missing'));
  });

  it('valida a configuração do provedor', () => {
    const base = { apiKey: 'k', chatModel: 'c', embeddingModel: 'e' };
    for (const bad of [
      { apiKey: ' ' },
      { chatModel: '' },
      { embeddingModel: '' },
      { timeoutMs: 0 },
      { maxRetries: -1 },
      { maxRetries: 1.5 },
    ]) {
      assert.throws(
        () => new OpenAiProvider({ ...base, ...bad }),
        (e: unknown) => e instanceof AiError && e.category === 'configuration',
      );
    }
  });
});
