import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppApiError, classifyMetaError, mapWebhookError, parseGraphError } from '../src';

describe('classifyMetaError — principais códigos da Meta', () => {
  const cases: [number, string, boolean][] = [
    [190, 'auth', false],
    [0, 'auth', false],
    [131005, 'auth', false],
    [130429, 'rate_limit', true],
    [131056, 'rate_limit', true],
    [131048, 'rate_limit', true],
    [80007, 'rate_limit', true],
    [131047, 'window_expired', false],
    [131026, 'recipient', false],
    [131050, 'recipient', false],
    [130403, 'recipient', false],
    [132001, 'template', false],
    [132000, 'template', false],
    [132015, 'template', false],
    [131052, 'media', false],
    [131053, 'media', false],
    [100, 'invalid_request', false],
    [131008, 'invalid_request', false],
    [131009, 'invalid_request', false],
    [131051, 'invalid_request', false],
    [131031, 'account', false],
    [131042, 'account', false],
    [368, 'account', false],
    [131000, 'temporary', true],
    [131016, 'temporary', true],
    [133004, 'temporary', true],
    [2, 'temporary', true],
  ];
  for (const [code, category, retryable] of cases) {
    it(`${code} -> ${category}${retryable ? ' (repetível)' : ''}`, () => {
      const info = classifyMetaError(code);
      assert.equal(info.category, category);
      assert.equal(info.retryable, retryable);
      assert.ok(info.description.length > 0);
    });
  }

  it('código desconhecido cai no status HTTP', () => {
    assert.equal(classifyMetaError(999999, 500).category, 'temporary');
    assert.equal(classifyMetaError(999999, 429).category, 'rate_limit');
    assert.equal(classifyMetaError(999999, 401).category, 'auth');
    assert.equal(classifyMetaError(999999, 400).category, 'invalid_request');
    assert.equal(classifyMetaError(undefined, undefined).category, 'unknown');
  });
});

describe('parseGraphError', () => {
  it('lê o corpo de erro do Graph API', () => {
    const error = parseGraphError(
      {
        error: {
          message: 'Re-engagement message',
          type: 'OAuthException',
          code: 131047,
          error_data: { messaging_product: 'whatsapp', details: 'Mais de 24h.' },
          fbtrace_id: 'AbCdEf',
        },
      },
      400,
    );
    assert.ok(error instanceof WhatsAppApiError);
    assert.equal(error.code, 131047);
    assert.equal(error.category, 'window_expired');
    assert.equal(error.details, 'Mais de 24h.');
    assert.equal(error.fbtraceId, 'AbCdEf');
    assert.equal(error.httpStatus, 400);
  });

  it('corpo inesperado (HTML, vazio) vira erro pelo status HTTP', () => {
    const error = parseGraphError(undefined, 502);
    assert.equal(error.category, 'temporary');
    assert.equal(error.retryable, true);
  });
});

describe('mapWebhookError', () => {
  it('mapeia erro de status do webhook', () => {
    const e = mapWebhookError({
      code: 130429,
      title: 'Rate limit hit',
      message: 'Rate limit hit',
      error_data: { details: 'Cloud API message throughput has been reached.' },
    });
    assert.equal(e.category, 'rate_limit');
    assert.equal(e.retryable, true);
    assert.equal(e.details, 'Cloud API message throughput has been reached.');
  });

  it('entrada estranha não quebra', () => {
    assert.equal(mapWebhookError(null).category, 'unknown');
    assert.equal(mapWebhookError('x').code, undefined);
  });
});
