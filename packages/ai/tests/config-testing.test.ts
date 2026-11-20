import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  AiConfigError,
  AiError,
  FakeEmbeddingProvider,
  FakeLlmProvider,
  OpenAiProvider,
  createOpenAiProvider,
  defineTool,
  loadAiConfig,
} from '../src';

const VALID = {
  OPENAI_API_KEY: 'sk-test-123',
  AI_CHAT_MODEL: 'modelo-chat',
  AI_EMBEDDING_MODEL: 'modelo-emb',
};

describe('configuração (falha rápida)', () => {
  it('lê o ambiente com padrões', () => {
    const config = loadAiConfig(VALID);
    assert.equal(config.baseUrl, 'https://api.openai.com');
    assert.equal(config.timeoutMs, 30_000);
    assert.equal(config.maxRetries, 2);
    assert.deepEqual(config.pricing, {});
    assert.equal(config.embeddingDimensions, undefined);
  });

  it('lê tudo, inclusive preços e dimensão', () => {
    const config = loadAiConfig({
      ...VALID,
      AI_EMBEDDING_DIMENSIONS: '1536',
      AI_TIMEOUT_MS: '5000',
      AI_MAX_RETRIES: '0',
      AI_BASE_URL: 'http://localhost:8080',
      AI_PRICING_JSON: '{"modelo-chat":{"inputPerMillion":1,"outputPerMillion":2}}',
    });
    assert.equal(config.embeddingDimensions, 1536);
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.maxRetries, 0);
    assert.equal(config.pricing['modelo-chat']?.outputPerMillion, 2);
  });

  it('lista TODOS os problemas de uma vez (strings vazias contam como ausentes)', () => {
    assert.throws(
      () => loadAiConfig({ OPENAI_API_KEY: '', AI_PRICING_JSON: '{', AI_TIMEOUT_MS: '5' }),
      (e: unknown) => {
        assert.ok(e instanceof AiConfigError);
        const text = e.issues.join('\n');
        for (const name of [
          'OPENAI_API_KEY',
          'AI_CHAT_MODEL',
          'AI_EMBEDDING_MODEL',
          'AI_TIMEOUT_MS',
          'AI_PRICING_JSON',
        ]) {
          assert.ok(text.includes(name), `faltou ${name}`);
        }
        return true;
      },
    );
  });

  it('o erro nunca repete o valor da chave', () => {
    assert.throws(
      () => loadAiConfig({ ...VALID, OPENAI_API_KEY: 'sk-SEGREDO-123', AI_TIMEOUT_MS: 'xx' }),
      (e: unknown) => e instanceof AiConfigError && !e.message.includes('sk-SEGREDO-123'),
    );
  });

  it('createOpenAiProvider monta o provedor com a configuração', () => {
    const provider = createOpenAiProvider(loadAiConfig(VALID));
    assert.ok(provider instanceof OpenAiProvider);
    assert.equal(provider.name, 'openai');
  });
});

describe('dublês para testes', () => {
  it('FakeLlmProvider: respostas roteirizadas, erros e registro das chamadas', async () => {
    const tool = defineTool({ name: 'x', description: 'x', parameters: z.object({}) });
    const fake = new FakeLlmProvider([
      { text: 'primeira' },
      new AiError('falha', { category: 'temporary', retryable: true }),
    ]);
    assert.equal(
      (
        await fake.generate({
          tenantId: 't',
          messages: [{ role: 'user', content: 'oi' }],
          tools: [tool] as const,
        })
      ).text,
      'primeira',
    );
    await assert.rejects(fake.generate({ tenantId: 't', messages: [] }), AiError);
    assert.equal((await fake.generate({ tenantId: 't', messages: [] })).text, 'resposta de teste');
    assert.equal(fake.calls.length, 3);
  });

  it('FakeEmbeddingProvider: determinístico, normalizado e com a dimensão pedida', async () => {
    const fake = new FakeEmbeddingProvider(4);
    const a = await fake.embed({ tenantId: 't', input: ['gato', 'cachorro'] });
    const b = await fake.embed({ tenantId: 't', input: ['gato'], dimensions: 4 });
    assert.deepEqual(a.embeddings[0], b.embeddings[0]);
    assert.notDeepEqual(a.embeddings[0], a.embeddings[1]);
    const norm = Math.sqrt(a.embeddings[0]!.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9);
    assert.equal(a.dimensions, 4);
  });
});
