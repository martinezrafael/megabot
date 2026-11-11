import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { listUserTenants, prisma } from '@megabot/database';
import { createApp } from '../src/bootstrap';
import type { AppConfig } from '../src/config';
import { createMemoryMailer, type Mailer } from '../src/mailer';

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
      cookie?: string;
      origin?: string;
      redirect?: RequestRedirect;
    },
  ) => Promise<Response>;
  /** Cria um e-mail único para o teste e registra para limpeza. */
  newEmail: (label: string) => string;
  close: () => Promise<void>;
}

export async function startTestApp(options: { mailer?: Mailer } = {}): Promise<TestApp> {
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const config: AppConfig = {
    port,
    authUrl: baseUrl,
    webUrl: WEB_URL,
    authSecret: 'test-secret-test-secret-test-secret-123456',
    google: { clientId: 'test-google-client-id', clientSecret: 'test-google-client-secret' },
    smtp: { host: 'localhost', port: 1025, from: 'test@megabot.local' },
  };
  const mailer = createMemoryMailer();
  const app = await createApp({ config, mailer: options.mailer ?? mailer });
  await app.listen(port);

  const run = randomUUID().slice(0, 8);
  const emails: string[] = [];

  return {
    baseUrl,
    mailer,
    app,
    newEmail: (label) => {
      const email = `${label}-${run}@auth.test`;
      emails.push(email);
      return email;
    },
    api: (path, init = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        redirect: init.redirect ?? 'manual',
        headers: {
          Origin: init.origin ?? WEB_URL,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
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
