import { createAuthClient } from 'better-auth/react';

/**
 * Cliente do Better Auth usado nos componentes do navegador.
 * Aponta para a API (NestJS) e envia os cookies de sessão (`credentials: include`).
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
  fetchOptions: { credentials: 'include' },
});
