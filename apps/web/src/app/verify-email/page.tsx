import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth-card';
import { getMe } from '@/lib/server-session';

/**
 * Destino do link do e-mail de confirmação.
 * - Sucesso: o Better Auth já criou a sessão -> mandamos para o dashboard.
 * - Falha: chega com ?error=... -> mostramos aviso.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  if (!error && (await getMe())) redirect('/dashboard');

  return (
    <AuthCard
      title={error ? 'Link inválido' : 'Verifique seu e-mail'}
      subtitle={
        error
          ? 'O link de confirmação expirou ou já foi usado.'
          : 'Abra o link que enviamos para ativar sua conta.'
      }
    >
      <p className="footer">
        <a href="/sign-in">Ir para o login</a>
      </p>
    </AuthCard>
  );
}
