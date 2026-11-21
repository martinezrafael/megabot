/**
 * Chamadas à API feitas pelo NAVEGADOR (componentes 'use client'), com o cookie de sessão.
 * Server Components usam os `fetch*` de lib/knowledge.ts, que repassam o cookie recebido.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  /** Mensagem pronta para mostrar (vem da API quando ela explica o problema). */
  error?: string;
}

/** Mensagem de erro da API (`ErrorResponseDto.message`) ou um texto genérico por status. */
async function errorMessageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    const message = body.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (Array.isArray(message) && message.length > 0) return message.join('; ');
  } catch {
    // resposta sem JSON (413 do servidor, por exemplo)
  }
  if (response.status === 413) return 'O arquivo é maior que o limite permitido.';
  if (response.status === 401) return 'Sua sessão expirou. Entre de novo.';
  return `Algo deu errado (código ${response.status}). Tente novamente.`;
}

export async function apiRequest<T>(
  path: string,
  init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers: {
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: 'Não foi possível falar com o servidor. Verifique sua conexão.',
    };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: await errorMessageOf(response) };
  }
  if (response.status === 204) return { ok: true, status: 204 };
  return { ok: true, status: response.status, data: (await response.json()) as T };
}
