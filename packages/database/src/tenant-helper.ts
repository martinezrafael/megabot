import { Prisma } from '@prisma/client';
import { prisma } from './client';

/**
 * Executa queries dentro de uma transação do PostgreSQL com a sessão do tenant isolada por RLS.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
): Promise<T> {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(tenantId)) {
    throw new Error(`Invalid tenantId format: ${tenantId}`);
  }

  // O Prisma $transaction garante que todas as operações dentro do callback
  // compartilham a mesma conexão física exclusiva durante o seu ciclo.
  return prisma.$transaction(async (tx) => {
    // Definimos a variável de configuração na sessão da conexão atual da transação
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true);`;

    // Executa a função passando o cliente da transação
    return await fn(tx);
  }, options);
}

export type TenantTransactionClient = Prisma.TransactionClient;
