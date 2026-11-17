import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NonRetryableError, isRetryable, noopLogger } from '@megabot/queue';
import { createSystemPingHandler } from '../src/handlers/system-ping';

const ctx = (simulate: 'ok' | 'retryable-failure' | 'fatal-failure') => ({
  jobId: 'j',
  tenantId: '11111111-1111-4111-8111-111111111111',
  payload: { tenantId: '11111111-1111-4111-8111-111111111111', simulate },
  attempt: 1,
  maxAttempts: 3,
  signal: new AbortController().signal,
  logger: noopLogger,
});

describe('handler system.ping', () => {
  it('ok conclui', async () => {
    await createSystemPingHandler({ allowSimulation: true })(ctx('ok'));
  });

  it('retryable-failure lança erro repetível', async () => {
    await assert.rejects(
      () => createSystemPingHandler({ allowSimulation: true })(ctx('retryable-failure')),
      (e: unknown) => isRetryable(e),
    );
  });

  it('fatal-failure lança NonRetryableError', async () => {
    await assert.rejects(
      () => createSystemPingHandler({ allowSimulation: true })(ctx('fatal-failure')),
      NonRetryableError,
    );
  });

  it('em produção a simulação é ignorada', async () => {
    const handler = createSystemPingHandler({ allowSimulation: false });
    await handler(ctx('fatal-failure'));
    await handler(ctx('retryable-failure'));
  });
});
