import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { AppConfig } from '../config';
import { resolveRequestId } from './request-id';
import { sanitizeUrl } from './sanitize-url';

/**
 * Logger estruturado (JSON) com pino.
 *
 * Todo log emitido durante uma requisição carrega `request_id`. Depois que o
 * AuthGuard identifica o usuário, `tenant_id` e `user_id` são acrescentados
 * (inclusive no log final "request completed"). Requisições anônimas não têm
 * `tenant_id`.
 *
 * `stream` existe para os testes capturarem as linhas de log.
 */
export function createLoggerModule(config: AppConfig, stream?: DestinationStream): DynamicModule {
  const options = {
    level: config.logLevel,
    base: { service: 'api' },
    genReqId: (req: IncomingMessage, res: ServerResponse) => resolveRequestId(req, res),
    customProps: (req: IncomingMessage & { id?: unknown }) => ({ request_id: req.id }),
    // 5xx = erro nosso; 4xx = problema da requisição; resto = informação.
    customLogLevel: (_req: IncomingMessage, res: ServerResponse, error?: Error) => {
      if (error || res.statusCode >= 500) return 'error' as const;
      if (res.statusCode >= 400) return 'warn' as const;
      return 'info' as const;
    },
    // Sonda de saúde (a cada poucos segundos) só polui o log.
    autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
    // Não logamos cabeçalhos (cookies/Authorization) e limpamos a URL.
    serializers: {
      req: (req: { id?: string; method?: string; url?: string; raw?: IncomingMessage }) => ({
        id: req.id,
        method: req.method,
        url: sanitizeUrl(req.url),
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
    // Em desenvolvimento, saída legível. Em produção/CI, JSON puro.
    transport:
      !stream && config.env === 'development'
        ? { target: 'pino-pretty', options: { singleLine: true, ignore: 'pid,hostname,service' } }
        : undefined,
  };

  return LoggerModule.forRoot({
    pinoHttp: stream ? [options, stream] : options,
    // Faz o PinoLogger.assign({tenant_id}) valer também no log "request completed".
    assignResponse: true,
  });
}
