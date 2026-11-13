import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { parseWebEnv } from '@/env';
import { fetchMe, type Me } from './me';

export { safeNext, type Me } from './me';

/**
 * Para Server Components: quem está logado? (null = ninguém)
 * É a validação "de verdade" da sessão; o middleware só checa se o cookie existe.
 *
 * `cache` deduplica: layout e página chamam getMe() e a API é consultada UMA vez por requisição.
 */
export const getMe = cache(async (): Promise<Me | null> => {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const { serverApiUrl } = parseWebEnv(process.env);

  return fetchMe({
    apiUrl: serverApiUrl,
    cookie: cookieStore.toString(),
    forwardedFor: requestHeaders.get('x-forwarded-for') ?? undefined,
    requestId: requestHeaders.get('x-request-id') ?? undefined,
  });
});
