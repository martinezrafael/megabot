import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

// Aceita só caracteres "seguros": impede injeção de linhas/JSON falsos nos logs.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

type WithId = IncomingMessage & { id?: string | number | object };

/**
 * Define o request id da requisição (uma única vez) e o devolve no cabeçalho
 * `x-request-id`. Se o chamador (ou o proxy) já mandou um id válido, ele é
 * reaproveitado, o que permite rastrear a mesma requisição entre serviços.
 */
export function resolveRequestId(req: WithId, res: ServerResponse): string {
  if (typeof req.id === 'string') return req.id;

  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();

  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Middleware Express: roda cedo para que até erros de body-parser tenham request id. */
export function requestIdMiddleware(req: WithId, res: ServerResponse, next: () => void): void {
  resolveRequestId(req, res);
  next();
}
