import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { SignUpForm } from '@/components/sign-up-form';
import { getMe } from '@/lib/server-session';

export default async function SignUpPage() {
  if (await getMe()) redirect('/dashboard');
  return (
    <AuthCard title="Criar conta" subtitle="Comece a usar o Megabot.">
      <SignUpForm />
    </AuthCard>
  );
}
