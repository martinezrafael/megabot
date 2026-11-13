import type { components } from './api/schema';

/** Tipo gerado a partir do contrato OpenAPI da API (apps/api/openapi.json). */
export type Me = components['schemas']['MeResponseDto'];

export interface FetchMeOptions {
  apiUrl: string;
  /** Cabeçalho Cookie do navegador, repassado à API. */
  cookie: string;
  /** IP do usuário (x-forwarded-for) para o rate limit da API enxergar o cliente real. */
  forwardedFor?: string;
  /** Request id recebido (proxy), repassado para correlacionar logs entre web e API. */
  requestId?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Pergunta à API quem está logado. null = sem sessão válida.
 * (Função pura: recebe tudo por parâmetro, por isso é fácil de testar.)
 */
export async function fetchMe({
  apiUrl,
  cookie,
  forwardedFor,
  requestId,
  fetchImpl = fetch,
}: FetchMeOptions): Promise<Me | null> {
  const response = await fetchImpl(`${apiUrl}/me`, {
    headers: {
      cookie,
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
    cache: 'no-store',
  });

  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Falha ao consultar /me: ${response.status}`);
  return (await response.json()) as Me;
}

/** Só aceita caminhos internos (evita open redirect via ?next=). */
export function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}
