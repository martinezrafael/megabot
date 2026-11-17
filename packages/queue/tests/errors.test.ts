import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NonRetryableError, describeError, isRetryable } from '../src';

describe('erros', () => {
  it('NonRetryableError não é repetível', () => {
    assert.equal(isRetryable(new NonRetryableError('x')), false);
  });

  it('respeita retryable:false de outros erros (ex.: WhatsAppApiError)', () => {
    assert.equal(isRetryable(Object.assign(new Error('janela'), { retryable: false })), false);
    assert.equal(isRetryable(Object.assign(new Error('rate'), { retryable: true })), true);
  });

  it('erro desconhecido é repetível', () => {
    assert.equal(isRetryable(new Error('boom')), true);
    assert.equal(isRetryable('string solta'), true);
    assert.equal(isRetryable(null), true);
  });

  it('describeError trunca a mensagem, omite a stack e expõe a categoria', () => {
    const long = 'x'.repeat(1000);
    const out = describeError(Object.assign(new Error(long), { category: 'rate_limit' }));
    assert.equal(out.name, 'Error');
    assert.equal(out.code, 'rate_limit');
    assert.ok(out.message.length <= 301);
    assert.equal('stack' in out, false);
  });
});
