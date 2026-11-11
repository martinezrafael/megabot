'use client';

import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export function GoogleButton({ label = 'Continuar com Google' }: { label?: string }) {
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    // O Better Auth redireciona o navegador para o Google e, depois do login, de volta para callbackURL.
    const { error } = await authClient.signIn.social({
      provider: 'google',
      callbackURL: `${window.location.origin}/dashboard`,
    });
    if (error) setError('Login com Google indisponível no momento.');
  }

  return (
    <>
      <button type="button" onClick={handleClick}>
        {label}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
