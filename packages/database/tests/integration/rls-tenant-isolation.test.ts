import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';

describe('RLS Tenant Isolation Test Suite', () => {
  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;

  before(async () => {
    const [tenantA, tenantB] = await Promise.all([
      prisma.tenant.create({
        data: { name: 'Empresa A', slug: 'empresa-a-test' },
      }),
      prisma.tenant.create({
        data: { name: 'Empresa B', slug: 'empresa-b-test' },
      }),
    ]);

    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const [userA, userB] = await Promise.all([
      prisma.user.create({
        data: { name: 'User A', email: 'usera@empresa-a.com' },
      }),
      prisma.user.create({
        data: { name: 'User B', email: 'userb@empresa-b.com' },
      }),
    ]);

    userAId = userA.id;
    userBId = userB.id;

    await withTenant(tenantAId, (tx) =>
      tx.membership.create({
        data: { tenantId: tenantAId, userId: userAId, role: 'ADMIN' },
      }),
    );

    await withTenant(tenantBId, (tx) =>
      tx.membership.create({
        data: { tenantId: tenantBId, userId: userBId, role: 'MEMBER' },
      }),
    );
  });

  after(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "memberships", "users", "tenants" CASCADE;`);
    await prisma.$disconnect();
  });

  it('deve retornar apenas os memberships do Tenant A', async () => {
    const result = await withTenant(tenantAId, (tx) => tx.membership.findMany());

    assert.equal(result.length, 1);
    assert.equal(result[0].tenantId, tenantAId);
    assert.equal(result[0].userId, userAId);
  });

  it('deve retornar apenas os memberships do Tenant B', async () => {
    const result = await withTenant(tenantBId, (tx) => tx.membership.findMany());

    assert.equal(result.length, 1);
    assert.equal(result[0].tenantId, tenantBId);
    assert.equal(result[0].userId, userBId);
  });

  it('não deve permitir que o Tenant A consulte registros do Tenant B', async () => {
    const result = await withTenant(tenantAId, (tx) =>
      tx.membership.findFirst({ where: { tenantId: tenantBId } }),
    );

    assert.equal(result, null);
  });

  it('não deve retornar nada quando consultado sem contexto de tenant', async () => {
    const result = await prisma.membership.findMany();

    assert.equal(result.length, 0);
  });

  it('não deve permitir inserir membership em nome de outro tenant', async () => {
    await assert.rejects(
      withTenant(tenantAId, (tx) =>
        tx.membership.create({
          data: { tenantId: tenantBId, userId: userAId, role: 'MEMBER' },
        }),
      ),
    );
  });
});
