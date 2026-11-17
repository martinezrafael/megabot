import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { listUserTenants, prisma } from '@megabot/database';
import { createApp } from '../src/bootstrap';
import type { AppConfig } from '../src/config';
import type { DestinationStream } from 'pino';
import { createMemoryMailer, type Mailer } from '../src/mailer';
import type { QueueInspectorPort } from '../src/admin/admin-queues.service';

export const WEB_URL = 'http://localhost:3001';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export interface TestApp {
  baseUrl: string;
  mailer: ReturnType<typeof createMemoryMailer>;
  app: NestExpressApplication;
  /** fetch já apontando para a API, com Origin do front e cookie opcional. */
  api: (
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      /** Corpo já serializado (para testar JSON inválido ou grande demais). */
      rawBody?: string;
      cookie?: string;
      origin?: string;
      redirect?: RequestRedirect;
      headers?: Record<string, string>;
    },
  ) => Promise<Response>;
  /** Cria um e-mail único para o teste e registra para limpeza. */
  newEmail: (label: string) => string;
  close: () => Promise<void>;
}

/** Configuração de teste: limites de rate limit altos e logs desligados. */
export function createTestConfig(port: number, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    port,
    authUrl: `http://localhost:${port}`,
    webUrl: WEB_URL,
    authSecret: 'test-secret-test-secret-test-secret-123456',
    google: { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret' },
    smtp: { host: 'localhost', port: 1025, from: 'test@megabot.local' },
    logLevel: 'silent',
    rateLimit: { windowMs: 60_000, max: 10_000, authMax: 10_000 },
    databaseUrl:
      process.env.DATABASE_URL ??
      'postgresql://megabot_app:megabot_pass@localhost:5432/megabot?schema=public',
    platformAdminEmails: [],
    trustProxy: false,
    swaggerEnabled: false,
    whatsapp: { appSecret: undefined, verifyToken: undefined },
    ...overrides,
  };
}

export interface StartTestAppOptions {
  mailer?: Mailer;
  config?: Partial<AppConfig>;
  logStream?: DestinationStream;
  dbPing?: () => Promise<unknown>;
  /** Troca o leitor das tabelas do pg-boss (tela de filas). */
  queueInspector?: QueueInspectorPort;
  /** Rótulos (como em `newEmail`) cujos e-mails serão administradores da plataforma. */
  platformAdminLabels?: string[];
}

export async function startTestApp(options: StartTestAppOptions = {}): Promise<TestApp> {
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const run = randomUUID().slice(0, 8);
  const emails: string[] = [];
  const emailFor = (label: string) => {
    const email = `${label}-${run}@auth.test`;
    if (!emails.includes(email)) emails.push(email);
    return email;
  };
  const config = createTestConfig(port, {
    platformAdminEmails: (options.platformAdminLabels ?? []).map(emailFor),
    ...options.config,
  });
  const mailer = createMemoryMailer();
  const app = await createApp({
    config,
    mailer: options.mailer ?? mailer,
    logStream: options.logStream,
    dbPing: options.dbPing,
    queueInspector: options.queueInspector,
  });
  await app.listen(port);

  return {
    baseUrl,
    mailer,
    app,
    newEmail: emailFor,
    api: (path, init = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: init.method ?? (init.body || init.rawBody ? 'POST' : 'GET'),
        redirect: init.redirect ?? 'manual',
        headers: {
          Origin: init.origin ?? WEB_URL,
          ...(init.body || init.rawBody ? { 'Content-Type': 'application/json' } : {}),
          ...(init.cookie ? { Cookie: init.cookie } : {}),
          ...init.headers,
        },
        body: init.rawBody ?? (init.body ? JSON.stringify(init.body) : undefined),
      }),
    close: async () => {
      // Remove só o que este teste criou (sem TRUNCATE).
      const users = await prisma.user.findMany({ where: { email: { in: emails } } });
      for (const user of users) {
        const tenants = await listUserTenants(user.id);
        await prisma.tenant.deleteMany({ where: { id: { in: tenants.map((t) => t.tenantId) } } });
      }
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
      await app.close();
      await prisma.$disconnect();
    },
  };
}

/** Extrai o primeiro link http(s) do corpo de texto do último e-mail enviado. */
export function lastLink(mailer: TestApp['mailer'], to: string): string {
  const message = [...mailer.outbox].reverse().find((m) => m.to === to);
  if (!message) throw new Error(`Nenhum e-mail enviado para ${to}`);
  const match = message.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error('Nenhum link encontrado no e-mail');
  return match[0];
}

/** Converte os Set-Cookie de uma resposta no valor do header Cookie. */
export function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Aguarda o e-mail (o envio é "fire and forget" no Better Auth). */
export async function waitForEmail(mailer: TestApp['mailer'], to: string, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (mailer.outbox.some((m) => m.to === to)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timeout esperando e-mail para ${to}`);
}

/** Cadastra, verifica o e-mail e devolve o cookie de uma sessão válida. */
export async function signUpVerified(t: TestApp, email: string, name = 'Teste'): Promise<string> {
  const signUp = await t.api('/api/auth/sign-up/email', {
    body: { name, email, password: 'senha-super-segura-123', callbackURL: `${WEB_URL}/dashboard` },
  });
  if (signUp.status !== 200) throw new Error(`cadastro falhou: ${signUp.status}`);
  await waitForEmail(t.mailer, email);
  const verify = await t.api(lastLink(t.mailer, email).replace(t.baseUrl, ''));
  return cookieFrom(verify);
}
