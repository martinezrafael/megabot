import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { SignInForm } from '@/components/sign-in-form';
import { getMe, safeNext } from '@/lib/server-session';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  if (await getMe()) redirect(safeNext(next));
  return (
    <AuthCard title="Entrar" subtitle="Acesse sua conta.">
      <SignInForm next={safeNext(next)} />
    </AuthCard>
  );
}
