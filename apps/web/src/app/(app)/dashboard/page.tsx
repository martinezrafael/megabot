import { redirect } from 'next/navigation';
import { getMe } from '@/lib/server-session';

export default async function DashboardPage() {
  const me = await getMe(); // já foi buscado no layout; o cache evita uma segunda chamada
  if (!me) redirect('/sign-in');

  return (
    <section>
      <h1>Olá, {me.user.name}!</h1>
      <p className="subtitle">Esta é a área autenticada do Megabot.</p>
    </section>
  );
}
