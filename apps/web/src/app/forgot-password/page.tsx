import { AuthCard } from '@/components/auth-card';
import { ForgotPasswordForm } from '@/components/forgot-password-form';

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Recuperar senha" subtitle="Informe seu e-mail para receber o link.">
      <ForgotPasswordForm />
      <p className="footer">
        <a href="/sign-in">Voltar para o login</a>
      </p>
    </AuthCard>
  );
}
