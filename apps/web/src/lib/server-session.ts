import { cookies } from 'next/headers';

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface Me {
  user: { id: string; email: string; name: string; image: string | null; emailVerified: boolean };
  tenant: { id: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' } | null;
}

/**
 * Para Server Components: pergunta à API quem está logado, repassando o cookie
 * do navegador. Retorna null se não houver sessão válida.
 * (É a validação "de verdade" - o middleware só olha se o cookie existe.)
 */
export async function getMe(): Promise<Me | null> {
  const cookieStore = await cookies();
  const response = await fetch(`${API_URL}/me`, {
    headers: { cookie: cookieStore.toString() },
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
