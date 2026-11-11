import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { prisma, provisionTenantForUser } from '@megabot/database';
import type { AppConfig } from '../config';
import { resetPasswordEmail, verificationEmail, type Mailer } from '../mailer';

/**
 * Envia o e-mail sem bloquear a resposta (evita revelar, pelo tempo de resposta,
 * se um e-mail existe) e sem derrubar o processo se o SMTP falhar.
 */
function sendInBackground(mailer: Mailer, message: Parameters<Mailer['send']>[0]): void {
  mailer.send(message).catch((error) => {
    console.error(`Falha ao enviar e-mail "${message.subject}" para ${message.to}:`, error);
  });
}

export interface CreateAuthOptions {
  config: AppConfig;
  mailer: Mailer;
}

/**
 * Cria a instância do Better Auth. É uma função (e não uma constante) para
 * que os testes possam injetar um mailer falso e uma configuração própria.
 */
export function createAuth({ config, mailer }: CreateAuthOptions) {
  return betterAuth({
    baseURL: config.authUrl,
    secret: config.authSecret,
    // Só aceitamos requisições vindas do nosso front-end (proteção CSRF).
    trustedOrigins: [config.webUrl],

    // Usa o mesmo Prisma/Postgres do projeto. Os modelos User, Session, Account
    // e Verification estão em packages/database/prisma/schema.prisma.
    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    // Nossas colunas id são UUID (Postgres), então geramos UUID em vez do id padrão.
    advanced: { database: { generateId: 'uuid' } },

    emailAndPassword: {
      enabled: true,
      // Quem não confirmou o e-mail não consegue logar.
      requireEmailVerification: true,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url }) => {
        sendInBackground(mailer, { to: user.email, ...resetPasswordEmail(user.name, url) });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        sendInBackground(mailer, { to: user.email, ...verificationEmail(user.name, url) });
      },
    },

    // Login com Google (só liga se as credenciais existirem).
    socialProviders: config.google ? { google: config.google } : {},

    databaseHooks: {
      user: {
        create: {
          // Roda logo depois que o usuário é criado (cadastro com senha OU Google).
          // Cria o tenant e a membership OWNER. É idempotente.
          after: async (user) => {
            await provisionTenantForUser({ id: user.id, name: user.name, email: user.email });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
