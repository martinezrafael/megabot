import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from './client';
import { assertUuid } from './uuid';

export interface ProvisionResult {
  tenantId: string;
  /** false quando o usuário já tinha tenant (chamada repetida = no-op) */
  created: boolean;
}

/** "João da Silva" -> "joao-da-silva" */
export function slugify(input: string): string {
  const base = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'empresa';
}

/**
 * Cria o tenant do usuário no primeiro cadastro (usuário vira OWNER).
 *
 * Pontos importantes:
 * 1. Tudo acontece numa única transação.
 * 2. `app.tenant_id` é definido com o UUID do tenant NOVO antes de inserir a
 *    membership. Sem isso, o WITH CHECK da policy de RLS bloqueia o INSERT.
 * 3. `app.user_id` permite checar se o usuário já tem membership (idempotência).
 * 4. O advisory lock evita dois tenants se o hook rodar duas vezes em paralelo.
 */
export async function provisionTenantForUser(user: {
  id: string;
  name: string;
  email: string;
}): Promise<ProvisionResult> {
  assertUuid(user.id, 'userId');

  const tenantId = randomUUID();
  const displayName = user.name?.trim() || user.email.split('@')[0];
  const slug = `${slugify(displayName)}-${randomBytes(3).toString('hex')}`;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;

    const existing = await tx.membership.findFirst({
      where: { userId: user.id },
      select: { tenantId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return { tenantId: existing.tenantId, created: false };
    }

    await tx.tenant.create({
      data: { id: tenantId, name: `Empresa de ${displayName}`, slug },
    });
    await tx.membership.create({
      data: { tenantId, userId: user.id, role: 'OWNER' },
    });

    return { tenantId, created: true };
  });
}
