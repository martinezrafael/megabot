import { z } from 'zod';

/**
 * Configuração da API, validada com Zod na inicialização.
 *
 * Princípio "falha rápida": se alguma variável estiver ausente ou inválida, o
 * processo NÃO sobe. Todos os problemas são listados de uma vez só (em vez de
 * descobrir um por vez a cada tentativa).
 */

export interface AppConfig {
  env: 'development' | 'test' | 'production';
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
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  rateLimit: {
    /** Janela de contagem, em milissegundos. */
    windowMs: number;
    /** Máximo de requisições por IP na janela (rotas em geral). */
    max: number;
    /** Máximo por IP na janela para rotas de autenticação (login, cadastro, reset...). */
    authMax: number;
  };
  /** Valor do `trust proxy` do Express (necessário para enxergar o IP real atrás de um proxy). */
  trustProxy: boolean | number | string;
  /** Expõe a documentação interativa em /docs. Desligada por padrão em produção. */
  swaggerEnabled: boolean;
}

/** Erro lançado quando a configuração é inválida. A mensagem já vem formatada para o terminal. */
export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Configuração inválida. Corrija o .env e tente de novo:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

const port = z.coerce.number({ error: 'precisa ser um número' }).int().min(1).max(65535);
const positiveInt = z.coerce.number({ error: 'precisa ser um número' }).int().positive();
const url = z.url({ error: 'precisa ser uma URL válida (ex.: http://localhost:3000)' });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),

    DATABASE_URL: z
      .string({ error: 'obrigatória' })
      .regex(/^postgres(ql)?:\/\//, 'precisa começar com postgresql://'),

    BETTER_AUTH_SECRET: z
      .string({ error: 'obrigatória (gere com: openssl rand -base64 32)' })
      .min(32, 'precisa ter pelo menos 32 caracteres (gere com: openssl rand -base64 32)')
      .refine((value) => !/^troque-por/i.test(value), {
        error: 'ainda é o valor de exemplo do .env.example (gere um com: openssl rand -base64 32)',
      }),
    BETTER_AUTH_URL: url.optional(),
    WEB_URL: url.optional(),

    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: port.default(1025),
    MAIL_FROM: z.string().default('Megabot <no-reply@megabot.local>'),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

    RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(60),
    RATE_LIMIT_MAX: positiveInt.default(300),
    RATE_LIMIT_AUTH_MAX: positiveInt.default(20),
    TRUST_PROXY: z.string().default('false'),

    SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_ID'],
        message:
          'GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET precisam ser definidos juntos (ou ambos vazios)',
      });
    }
    // Em produção não aceitamos "adivinhar" endereços: tudo explícito.
    if (env.NODE_ENV === 'production') {
      for (const key of ['BETTER_AUTH_URL', 'WEB_URL'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória em produção' });
        }
      }
    }
  });

function parseTrustProxy(value: string): AppConfig['trustProxy'] {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // ex.: "loopback" ou uma lista de CIDRs
}

/** Variáveis vazias (`GOOGLE_CLIENT_ID=`) contam como "não definidas". */
function withoutEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(withoutEmptyValues(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const key = issue.path.join('.') || '(geral)';
        return `${key}: ${issue.message}`;
      }),
    );
  }

  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    authUrl: e.BETTER_AUTH_URL ?? `http://localhost:${e.PORT}`,
    webUrl: e.WEB_URL ?? 'http://localhost:3001',
    authSecret: e.BETTER_AUTH_SECRET,
    google:
      e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET
        ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET }
        : undefined,
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      from: e.MAIL_FROM,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
    },
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_SECONDS * 1000,
      max: e.RATE_LIMIT_MAX,
      authMax: e.RATE_LIMIT_AUTH_MAX,
    },
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    swaggerEnabled: e.SWAGGER_ENABLED ? e.SWAGGER_ENABLED === 'true' : e.NODE_ENV !== 'production',
  };
}
