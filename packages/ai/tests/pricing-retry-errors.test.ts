import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AiError,
  backoffDelay,
  classifyProviderError,
  estimateCostUsd,
  findPricing,
  parsePricingTable,
  parseRetryAfter,
} from '../src';

describe('custo estimado', () => {
  const pricing = { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 };

  it('calcula entrada + saída por milhão de tokens', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 500_000 },
      pricing,
    );
    assert.equal(cost, 2 + 4);
  });

  it('cobra os tokens em cache pelo preço de cache', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 0 },
      pricing,
    );
    assert.equal(cost, 0.4 * 2 + 0.6 * 0.5);
  });

  it('sem preço de cache, o cache custa como entrada normal', () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 },
      { inputPerMillion: 2, outputPerMillion: 8 },
    );
    assert.equal(cost, 2);
  });

  it('cache maior que a entrada é limitado à entrada; sem preço → null; zero tokens → 0', () => {
    assert.equal(
      estimateCostUsd({ inputTokens: 100, cachedInputTokens: 999, outputTokens: 0 }, pricing),
      0.00005,
    );
    assert.equal(
      estimateCostUsd({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, undefined),
      null,
    );
    assert.equal(
      estimateCostUsd({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, pricing),
      0,
    );
  });

  it('não acumula erro de ponto flutuante (arredonda em 1e-9)', () => {
    const cost = estimateCostUsd(
      { inputTokens: 3, cachedInputTokens: 0, outputTokens: 7 },
      { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    );
    assert.equal(cost, 0.00000465);
  });
});

describe('tabela de preços', () => {
  it('lê o JSON válido (saída padrão 0)', () => {
    const table = parsePricingTable('{"m":{"inputPerMillion":1}}');
    assert.deepEqual(table, { m: { inputPerMillion: 1, outputPerMillion: 0 } });
    assert.deepEqual(parsePricingTable(undefined), {});
    assert.deepEqual(parsePricingTable('  '), {});
  });

  it('recusa JSON quebrado, preço negativo e campo desconhecido', () => {
    assert.throws(() => parsePricingTable('{'), /não é um JSON válido/);
    assert.throws(() => parsePricingTable('{"m":{"inputPerMillion":-1}}'), /inputPerMillion/);
    assert.throws(() => parsePricingTable('{"m":{"inputPerMillion":1,"x":2}}'), /m/);
    assert.throws(() => parsePricingTable('{"m":{"outputPerMillion":2}}'), /inputPerMillion/);
  });

  it('acha o preço pelo nome exato ou pelo prefixo mais longo (modelo versionado)', () => {
    const table = {
      'modelo-x': { inputPerMillion: 1, outputPerMillion: 1 },
      'modelo-x-mini': { inputPerMillion: 0.1, outputPerMillion: 0.1 },
    };
    assert.equal(findPricing(table, 'modelo-x')?.inputPerMillion, 1);
    assert.equal(findPricing(table, 'modelo-x-mini-2026-01-01')?.inputPerMillion, 0.1);
    assert.equal(findPricing(table, 'modelo-x-2026-01-01')?.inputPerMillion, 1);
    assert.equal(findPricing(table, 'outro'), undefined);
    assert.equal(findPricing(table, undefined, 'modelo-x')?.inputPerMillion, 1);
  });
});

describe('classificação de erros do provedor', () => {
  const cases: Array<[number, string | undefined, string, boolean]> = [
    [401, undefined, 'auth', false],
    [403, undefined, 'auth', false],
    [429, 'rate_limit_exceeded', 'rate_limit', true],
    [429, 'insufficient_quota', 'quota', false],
    [400, 'context_length_exceeded', 'context_length', false],
    [400, 'content_policy_violation', 'content_filter', false],
    [400, 'invalid_prompt', 'content_filter', false],
    [400, undefined, 'invalid_request', false],
    [404, 'model_not_found', 'invalid_request', false],
    [422, undefined, 'invalid_request', false],
    [408, undefined, 'temporary', true],
    [409, undefined, 'temporary', true],
    [500, undefined, 'temporary', true],
    [502, undefined, 'temporary', true],
    [503, undefined, 'temporary', true],
    [529, undefined, 'temporary', true],
    [302, undefined, 'unknown', false],
  ];
  for (const [status, code, category, retryable] of cases) {
    it(`HTTP ${status}${code ? ` (${code})` : ''} → ${category}, retryable=${retryable}`, () => {
      const error = classifyProviderError({ httpStatus: status, code });
      assert.ok(error instanceof AiError);
      assert.equal(error.category, category);
      assert.equal(error.retryable, retryable);
      assert.equal(error.httpStatus, status);
    });
  }

  it('a mensagem do provedor fica em providerMessage (truncada), nunca em message', () => {
    const long = 'segredo-do-prompt '.repeat(100);
    const error = classifyProviderError({ httpStatus: 400, message: long });
    assert.ok(!error.message.includes('segredo-do-prompt'));
    assert.equal(error.providerMessage?.length, 300);
  });
});

describe('retentativa', () => {
  it('backoff exponencial com jitter limitado ao teto', () => {
    const o = { baseDelayMs: 100, maxDelayMs: 1000 };
    assert.equal(
      backoffDelay(1, o, () => 0.999),
      99,
    );
    assert.equal(
      backoffDelay(2, o, () => 0.999),
      199,
    );
    assert.equal(
      backoffDelay(3, o, () => 0.999),
      399,
    );
    assert.equal(
      backoffDelay(10, o, () => 0.999),
      999,
    );
    assert.equal(
      backoffDelay(3, o, () => 0),
      0,
    );
  });

  it('Retry-After em segundos, em data HTTP, ausente e ilegível', () => {
    assert.equal(parseRetryAfter('5', 0), 5000);
    assert.equal(parseRetryAfter('0.5', 0), 500);
    assert.equal(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')),
      10_000,
    );
    assert.equal(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2020 00:00:00 GMT')),
      0,
    );
    assert.equal(parseRetryAfter(null, 0), undefined);
    assert.equal(parseRetryAfter('abc', 0), undefined);
  });
});
