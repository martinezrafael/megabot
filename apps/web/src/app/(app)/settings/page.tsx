import { redirect } from 'next/navigation';
import { getMe } from '@/lib/server-session';

export default async function SettingsPage() {
  const me = await getMe();
  if (!me) redirect('/sign-in');

  return (
    <section>
      <h1>Conta</h1>
      <dl>
        <dt>Nome</dt>
        <dd>{me.user.name}</dd>
        <dt>E-mail</dt>
        <dd>{me.user.email}</dd>
        <dt>E-mail verificado</dt>
        <dd>{me.user.emailVerified ? 'Sim' : 'Não'}</dd>
        <dt>Empresa (tenant)</dt>
        <dd>{me.tenant?.id ?? '—'}</dd>
        <dt>Papel</dt>
        <dd>{me.tenant?.role ?? '—'}</dd>
      </dl>
    </section>
  );
}
