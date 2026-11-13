import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { sanitizeUrl } from '../logging/sanitize-url';

interface NormalizedError {
  status: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

const GENERIC_MESSAGE = 'Erro interno do servidor.';

function statusName(status: number): string {
  return HttpStatus[status]
    ? String(HttpStatus[status])
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    : 'Error';
}

/** Erros "soltos" do Express/body-parser (JSON inválido, corpo grande demais...): status 4xx. */
function httpErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value < 500 ? value : undefined;
}

export function normalizeException(exception: unknown): NormalizedError {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const body = exception.getResponse();

    if (typeof body === 'string') {
      return { status, error: statusName(status), message: body };
    }

    const record = body as Record<string, unknown>;
    const { message, error } = record;
    // `error` só é o "nome do erro" quando é texto (o Terminus usa `error` como objeto).
    const standardKeys = ['statusCode', 'message', ...(typeof error === 'string' ? ['error'] : [])];
    // Tudo que não é campo padrão (ex.: resultado do readiness) vai para `details`.
    const rest = Object.fromEntries(
      Object.entries(record).filter(([key]) => !standardKeys.includes(key)),
    );
    return {
      status,
      error: typeof error === 'string' ? error : statusName(status),
      message: Array.isArray(message) ? message.join('; ') : String(message ?? exception.message),
      details: Object.keys(rest).length > 0 ? rest : undefined,
    };
  }

  const looseStatus = httpErrorStatus(exception);
  if (looseStatus) {
    return {
      status: looseStatus,
      error: statusName(looseStatus),
      message: (exception as Error).message,
    };
  }

  // Qualquer outra coisa é um bug nosso: nunca vazamos detalhes ao cliente.
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: statusName(HttpStatus.INTERNAL_SERVER_ERROR),
    message: GENERIC_MESSAGE,
  };
}

/**
 * Filtro global: toda exceção vira uma resposta JSON no mesmo formato
 * (ErrorResponseDto), com o request id para facilitar o suporte.
 * Erros 5xx são registrados no log com stack trace; o cliente só vê a mensagem genérica.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Inject(HttpAdapterHost) private readonly httpAdapterHost: HttpAdapterHost,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ id?: string; originalUrl?: string; url?: string }>();
    const response = ctx.getResponse();

    const normalized = normalizeException(exception);
    const requestId = request.id ?? '';

    if (normalized.status >= 500) {
      this.logger.error({ err: exception, request_id: requestId }, 'Exceção não tratada');
    }

    // Se a resposta já começou a ser enviada, não dá mais para trocar o corpo.
    if (response.headersSent) return;

    httpAdapter.reply(
      response,
      {
        statusCode: normalized.status,
        error: normalized.error,
        message: normalized.message,
        requestId,
        path: sanitizeUrl(request.originalUrl ?? request.url),
        timestamp: new Date().toISOString(),
        ...(normalized.details ? { details: normalized.details } : {}),
      },
      normalized.status,
    );
  }
}
