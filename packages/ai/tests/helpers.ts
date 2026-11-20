import type { AiLogger, AiMetrics, LogFields } from '../src';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

type Responder = Response | Error | ((call: RecordedCall) => Response | Promise<Response>);

/** `fetch` falso: grava as chamadas e responde na ordem (a última resposta se repete). */
export function fakeFetch(responders: Responder[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    const next = responders[Math.min(calls.length - 1, responders.length - 1)]!;
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next.clone();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function apiError(
  status: number,
  code: string | null,
  message = 'mensagem do provedor com TRECHO-DO-PROMPT',
  headers: Record<string, string> = {},
): Response {
  return json({ error: { message, type: 'error', code } }, status, headers);
}

export function chatOk(
  over: Record<string, unknown> = {},
  usage: Record<string, unknown> | null = {},
) {
  return json(
    {
      id: 'chatcmpl-1',
      model: 'modelo-x-2026-01-01',
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Olá!' } },
      ],
      ...(usage === null
        ? {}
        : {
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 500,
              total_tokens: 1500,
              prompt_tokens_details: { cached_tokens: 0 },
              ...usage,
            },
          }),
      ...over,
    },
    200,
    { 'x-request-id': 'req_abc' },
  );
}

export function captureLogs() {
  const lines: Array<{ level: string; fields: LogFields; message?: string }> = [];
  const push = (level: string) => (fields: LogFields, message?: string) =>
    void lines.push({ level, fields, ...(message ? { message } : {}) });
  const logger: AiLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
  return { logger, lines };
}

export function captureMetrics() {
  const increments: Array<{ name: string; labels: Record<string, string>; value: number }> = [];
  const timings: Array<{ name: string; ms: number; labels: Record<string, string> }> = [];
  const metrics: AiMetrics = {
    increment: (name, labels = {}, value = 1) => void increments.push({ name, labels, value }),
    timing: (name, ms, labels = {}) => void timings.push({ name, ms, labels }),
  };
  return { metrics, increments, timings };
}

/**
 * Responde "nunca": só termina quando o sinal é abortado. Mantém um timer com referência para o
 * processo de teste não encerrar enquanto espera (o `AbortSignal.timeout` do código não segura o
 * processo vivo; em produção quem segura é o socket do `fetch`).
 */
export function hang(call: { signal: AbortSignal | undefined }): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const keepAlive = setTimeout(() => undefined, 60_000);
    call.signal?.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(call.signal?.reason);
    });
  });
}
