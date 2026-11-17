import { NonRetryableError, type JobHandler, type QUEUES } from '@megabot/queue';

/**
 * Handler do teste de fumaça. Em produção ignora `simulate` (ninguém consegue forçar falhas);
 * em dev/teste, `simulate` permite ver retentativa e DLQ funcionando (`pnpm queue:smoke`).
 */
export function createSystemPingHandler(options: {
  allowSimulation: boolean;
}): JobHandler<typeof QUEUES.systemPing> {
  return async ({ payload, attempt, maxAttempts, logger }) => {
    const simulate = options.allowSimulation ? payload.simulate : 'ok';
    if (simulate === 'fatal-failure') {
      throw new NonRetryableError('Falha definitiva simulada (system.ping)');
    }
    if (simulate === 'retryable-failure') {
      throw new Error(`Falha temporária simulada (tentativa ${attempt} de ${maxAttempts})`);
    }
    logger.info({ event: 'system.ping' }, 'pong');
  };
}
