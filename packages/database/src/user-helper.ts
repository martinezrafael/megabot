import { Prisma } from './generated/prisma/client';
import { prisma } from './client';
import { assertUuid } from './uuid';

/**
 * Executa queries numa transação com `app.user_id` definido.
 *
 * Serve para UMA coisa: descobrir a quais tenants um usuário pertence quando
 * ainda não sabemos o tenant (ex.: logo após o login). A policy
 * `membership_self_select_policy` libera apenas o SELECT das memberships do
 * próprio usuário. Para trabalhar DENTRO de um tenant, use `withTenant`.
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
): Promise<T> {
  assertUuid(userId, 'userId');

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true);`;
    return await fn(tx);
  }, options);
}

export interface UserTenant {
  tenantId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}

/**
 * Lista os tenants do usuário (do mais antigo para o mais novo).
 * Na Sprint 0 cada usuário tem apenas um; o primeiro é o tenant "ativo".
 */
export async function listUserTenants(userId: string): Promise<UserTenant[]> {
  const memberships = await withUser(userId, (tx) =>
    tx.membership.findMany({
      where: { userId },
      select: { tenantId: true, role: true },
      orderBy: { createdAt: 'asc' },
    }),
  );
  return memberships;
}
