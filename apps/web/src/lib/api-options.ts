import { cookies, headers } from 'next/headers';
import { parseWebEnv } from '@/env';

/**
 * Opções de requisição à API para Server Components, repassando o cookie de sessão de quem está
 * vendo a tela (e os cabeçalhos de rastreio).
 *
 * Mora aqui, e não dentro de uma `page.tsx`, porque o Next **não permite** que um arquivo de
 * página exporte qualquer outra coisa além do que ele conhece (`default`, `metadata`, `dynamic`
 * e companhia). Uma exportação extra numa página faz o `tsc` falhar na validação de rota que o
 * `next build` gera em `.next/types` — com a mensagem "is not assignable to type 'never'".
 */
export interface ApiFetchOptions {
  apiUrl: string;
  cookie: string;
  forwardedFor?: string;
  requestId?: string;
}

export async function apiOptions(): Promise<ApiFetchOptions> {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  return {
    apiUrl: parseWebEnv(process.env).serverApiUrl,
    cookie: cookieStore.toString(),
    forwardedFor: requestHeaders.get('x-forwarded-for') ?? undefined,
    requestId: requestHeaders.get('x-request-id') ?? undefined,
  };
}
