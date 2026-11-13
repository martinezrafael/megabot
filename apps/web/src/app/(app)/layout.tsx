import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { AppShell } from '@/components/app-shell';
import { SignOutButton } from '@/components/sign-out-button';
import { getMe } from '@/lib/server-session';

/**
 * Layout das telas autenticadas. Toda página dentro de app/(app)/ passa por aqui:
 * se a sessão não for válida, vai para o login. (O parêntese no nome da pasta
 * agrupa as rotas sem alterar a URL: /dashboard continua /dashboard.)
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/sign-in');

  return (
    <AppShell me={me} nav={<AppNav />} actions={<SignOutButton />}>
      {children}
    </AppShell>
  );
}
