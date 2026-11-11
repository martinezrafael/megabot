const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'E-mail ou senha incorretos.',
  EMAIL_NOT_VERIFIED: 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.',
  USER_ALREADY_EXISTS: 'Já existe uma conta com este e-mail.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'Já existe uma conta com este e-mail.',
  PASSWORD_TOO_SHORT: 'A senha deve ter pelo menos 8 caracteres.',
  INVALID_EMAIL: 'E-mail inválido.',
  INVALID_TOKEN: 'Link inválido ou expirado. Peça um novo.',
};

/** Traduz o código de erro do Better Auth para uma mensagem em português. */
export function authErrorMessage(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return null;
  return (error.code && MESSAGES[error.code]) || 'Algo deu errado. Tente novamente.';
}
