import { AuthCard } from '@/components/auth-card';
import { ResetPasswordForm } from '@/components/reset-password-form';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;

  // O Better Auth redireciona para cá com ?token=... (válido) ou ?error=INVALID_TOKEN.
  if (!token || error) {
    return (
      <AuthCard title="Link inválido" subtitle="Este link expirou ou já foi usado.">
        <p className="footer">
          <a href="/forgot-password">Pedir um novo link</a>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Nova senha" subtitle="Escolha uma nova senha para sua conta.">
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
