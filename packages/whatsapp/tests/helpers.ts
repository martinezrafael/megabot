import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogFields, WhatsAppLogger, WhatsAppMetrics } from '../src';

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: unknown;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** `fetch` falso: grava as chamadas e responde na ordem (ou via função). */
export function fakeFetch(responders: (Response | Responder)[] | Responder) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawBody = init?.body;
    let body: unknown = rawBody;
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body,
      rawBody,
    };
    calls.push(call);
    const next = Array.isArray(responders) ? responders[i++] : responders;
    if (!next)
      throw new Error('fakeFetch: sem resposta configurada para a chamada ' + calls.length);
    return typeof next === 'function' ? next(call) : next;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function captureLogs() {
  const lines: { level: string; fields: LogFields; message: string | undefined }[] = [];
  const logger: WhatsAppLogger = {
    debug: (fields, message) => lines.push({ level: 'debug', fields, message }),
    info: (fields, message) => lines.push({ level: 'info', fields, message }),
    warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    error: (fields, message) => lines.push({ level: 'error', fields, message }),
  };
  return { logger, lines };
}

export function captureMetrics() {
  const counters: { name: string; labels: Record<string, string> | undefined; value: number }[] =
    [];
  const timings: { name: string; ms: number; labels: Record<string, string> | undefined }[] = [];
  const metrics: WhatsAppMetrics = {
    increment: (name, labels, value = 1) => counters.push({ name, labels, value }),
    timing: (name, ms, labels) => timings.push({ name, ms, labels }),
  };
  return { metrics, counters, timings };
}
