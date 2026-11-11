'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth-client';

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    const form = new FormData(event.currentTarget);

    await authClient.requestPasswordReset({
      email: String(form.get('email')),
      // Página para onde o link do e-mail leva (com ?token=... na URL).
      redirectTo: `${window.location.origin}/reset-password`,
    });

    setLoading(false);
    // Mensagem igual exista ou não a conta (não revela quais e-mails estão cadastrados).
    setSent(true);
  }

  if (sent) {
    return (
      <p className="success">
        Se este e-mail estiver cadastrado, você receberá um link para redefinir a senha.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        E-mail
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <button className="primary" type="submit" disabled={loading}>
        {loading ? 'Enviando...' : 'Enviar link'}
      </button>
    </form>
  );
}
