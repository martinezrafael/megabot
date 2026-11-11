'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage } from '@/lib/auth-errors';
import { GoogleButton } from './google-button';
import { ResendVerificationButton } from './resend-verification-button';

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setUnverifiedEmail(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get('email'));

    const { error } = await authClient.signIn.email({
      email,
      password: String(form.get('password')),
    });

    setLoading(false);
    if (error) {
      if (error.code === 'EMAIL_NOT_VERIFIED') setUnverifiedEmail(email);
      return setError(authErrorMessage(error));
    }

    router.push(next);
    router.refresh();
  }

  return (
    <>
      <form onSubmit={handleSubmit}>
        <label>
          E-mail
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Senha
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error ? <p className="error">{error}</p> : null}
        {unverifiedEmail ? <ResendVerificationButton email={unverifiedEmail} /> : null}
        <button className="primary" type="submit" disabled={loading}>
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
      <p className="footer">
        <a href="/forgot-password">Esqueci minha senha</a>
      </p>
      <p className="divider">ou</p>
      <GoogleButton label="Entrar com Google" />
      <p className="footer">
        Não tem conta? <a href="/sign-up">Cadastre-se</a>
      </p>
    </>
  );
}
