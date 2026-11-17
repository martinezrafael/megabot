import pino, { type Logger } from 'pino';
import type { WorkerConfig } from './config';

/** Logs em JSON (uma linha por evento). Em desenvolvimento, saída legível via pino-pretty. */
export function createLogger(config: WorkerConfig): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'worker' },
    transport:
      config.env === 'development'
        ? { target: 'pino-pretty', options: { singleLine: true, ignore: 'pid,hostname,service' } }
        : undefined,
  });
}
