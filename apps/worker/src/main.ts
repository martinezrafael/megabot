import { loadWorkerConfig, WorkerConfigError } from './config';
import { createLogger } from './logger';
import { startWorker } from './worker';

/**
 * Ponto de entrada do worker.
 *
 * Desligamento gracioso: ao receber SIGTERM (deploy/orquestrador) ou SIGINT (Ctrl+C) o worker para de
 * pegar jobs novos, espera os em andamento terminarem (até WORKER_SHUTDOWN_TIMEOUT_SECONDS) e sai com
 * código 0. Um SEGUNDO sinal força a saída imediata (código 1). Job interrompido não se perde: o
 * pg-boss o considera expirado e o repete (entrega "pelo menos uma vez").
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadWorkerConfig();
  } catch (error) {
    if (error instanceof WorkerConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config);
  const worker = await startWorker(config, logger);

  let signalsReceived = 0;
  const shutdown = (signal: string, exitCode = 0) => {
    signalsReceived += 1;
    if (signalsReceived > 1) {
      logger.warn({ event: 'worker.force_exit', signal }, 'Segundo sinal: saindo agora');
      process.exit(1);
    }
    logger.info({ event: 'worker.signal', signal }, 'Sinal recebido');
    worker.stop().then(
      () => process.exit(exitCode),
      (error: unknown) => {
        logger.error({ event: 'worker.stop_failed', err: error }, 'Falha ao desligar');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Erro inesperado: registra, tenta desligar com elegância e sai com erro (o orquestrador reinicia).
  process.on('uncaughtException', (error) => {
    logger.fatal({ event: 'worker.uncaught_exception', err: error }, 'Exceção não tratada');
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal(
      { event: 'worker.unhandled_rejection', err: reason },
      'Promise rejeitada sem tratamento',
    );
    shutdown('unhandledRejection', 1);
  });
}

main().catch((error: unknown) => {
  console.error('Falha ao iniciar o worker:', error);
  process.exit(1);
});
