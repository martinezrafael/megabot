'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage } from '@/lib/auth-errors';
import { GoogleButton } from './google-button';
import { ResendVerificationButton } from './resend-verification-button';

export function SignUpForm() {
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));

    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email,
      password: String(form.get('password')),
      // Para onde o link do e-mail leva o usuário depois de confirmar.
      callbackURL: `${window.location.origin}/verify-email`,
    });

    setLoading(false);
    if (error) return setError(authErrorMessage(error));
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <>
        <p className="success">
          Quase lá! Enviamos um e-mail de confirmação para <strong>{sentTo}</strong>. Clique no link
          para ativar sua conta.
        </p>
        <p className="footer">
          <ResendVerificationButton email={sentTo} />
        </p>
      </>
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit}>
        <label>
          Nome
          <input name="name" type="text" autoComplete="name" required />
        </label>
        <label>
          E-mail
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Senha (mín. 8 caracteres)
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Criando conta...' : 'Criar conta'}
        </button>
      </form>
      <p className="divider">ou</p>
      <GoogleButton label="Cadastrar com Google" />
      <p className="footer">
        Já tem conta? <a href="/sign-in">Entrar</a>
      </p>
    </>
  );
}
