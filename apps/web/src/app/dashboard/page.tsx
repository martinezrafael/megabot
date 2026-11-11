import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { SignOutButton } from '@/components/sign-out-button';
import { getMe } from '@/lib/server-session';

export default async function DashboardPage() {
  // Validação real da sessão (o middleware só checou se o cookie existe).
  const me = await getMe();
  if (!me) redirect('/sign-in');

  return (
    <AuthCard title={`Olá, ${me.user.name}!`} subtitle="Você está logado.">
      <dl>
        <dt>E-mail</dt>
        <dd>{me.user.email}</dd>
        <dt>Verificado</dt>
        <dd>{me.user.emailVerified ? 'Sim' : 'Não'}</dd>
        <dt>Empresa (tenant)</dt>
        <dd>{me.tenant?.id ?? '—'}</dd>
        <dt>Papel</dt>
        <dd>{me.tenant?.role ?? '—'}</dd>
      </dl>
      <SignOutButton />
    </AuthCard>
  );
}
