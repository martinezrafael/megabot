'use client';

import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export function ResendVerificationButton({ email }: { email: string }) {
  const [sent, setSent] = useState(false);

  async function handleClick() {
    await authClient.sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}/verify-email`,
    });
    setSent(true);
  }

  if (sent) return <p className="success">Enviamos um novo e-mail de confirmação.</p>;
  return (
    <button type="button" className="link-button" onClick={handleClick}>
      Reenviar e-mail de confirmação
    </button>
  );
}
