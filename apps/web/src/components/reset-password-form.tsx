'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage } from '@/lib/auth-errors';

export function ResetPasswordForm({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(event.currentTarget);

    const { error } = await authClient.resetPassword({
      newPassword: String(form.get('password')),
      token,
    });

    setLoading(false);
    if (error) return setError(authErrorMessage(error));
    setDone(true);
  }

  if (done) {
    return (
      <>
        <p className="success">Senha alterada com sucesso.</p>
        <p className="footer">
          <a href="/sign-in">Entrar</a>
        </p>
      </>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        Nova senha (mín. 8 caracteres)
        <input name="password" type="password" autoComplete="new-password" minLength={8} required />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary" type="submit" disabled={loading}>
        {loading ? 'Salvando...' : 'Salvar nova senha'}
      </button>
    </form>
  );
}
