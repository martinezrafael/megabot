/**
 * Configuração da API, lida das variáveis de ambiente.
 * Centralizar aqui evita `process.env.X` espalhado e dá erro claro se faltar algo.
 */
export interface AppConfig {
  port: number;
  /** URL pública da API (onde o Better Auth responde). Ex.: http://localhost:3000 */
  authUrl: string;
  /** URL do front-end (Next.js). Usada em CORS, redirects e links dos e-mails. */
  webUrl: string;
  /** Segredo usado para assinar/criptografar tokens e cookies (mín. 32 caracteres). */
  authSecret: string;
  /** Google é opcional: sem as duas variáveis, o botão "Entrar com Google" fica desativado. */
  google?: { clientId: string; clientSecret: string };
  smtp: { host: string; port: number; from: string; user?: string; pass?: string };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const authSecret = required(env, 'BETTER_AUTH_SECRET');
  if (authSecret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET precisa ter pelo menos 32 caracteres');
  }

  const port = Number(env.PORT ?? 3000);

  return {
    port,
    authUrl: env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
    webUrl: env.WEB_URL ?? 'http://localhost:3001',
    authSecret,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    smtp: {
      host: env.SMTP_HOST ?? 'localhost',
      port: Number(env.SMTP_PORT ?? 1025),
      from: env.MAIL_FROM ?? 'Megabot <no-reply@megabot.local>',
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  };
}
