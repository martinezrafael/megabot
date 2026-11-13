/**
 * Remove de uma URL o que não pode ir para os logs: a query string
 * (`?token=...` dos links de e-mail) e o token no caminho do reset de senha.
 */
export function sanitizeUrl(url: string | undefined): string {
  if (!url) return '';
  const path = url.split('?')[0] ?? '';
  return path.replace(/(\/reset-password\/)[^/]+/, '$1[redacted]');
}
