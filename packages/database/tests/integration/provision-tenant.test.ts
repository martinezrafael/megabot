import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';
import { listUserTenants } from '../../src/user-helper';
import { provisionTenantForUser, slugify } from '../../src/provision-tenant';

const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `${n}-${RUN}@provision.test`;

describe('provisionTenantForUser', () => {
  const userIds: string[] = [];

  async function newUser(name: string) {
    const user = await prisma.user.create({ data: { name, email: email(name.toLowerCase()) } });
    userIds.push(user.id);
    return user;
  }

  after(async () => {
    // Remove só o que este teste criou (sem TRUNCATE, para não afetar outros testes).
    const tenantIds: string[] = [];
    for (const id of userIds) {
      tenantIds.push(...(await listUserTenants(id)).map((t) => t.tenantId));
    }
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } }); // cascade remove memberships
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  before(() => {
    assert.equal(slugify('João da Silva!'), 'joao-da-silva');
  });

  it('cria um tenant e uma membership OWNER no primeiro cadastro', async () => {
    const user = await newUser('Ana');
    const result = await provisionTenantForUser(user);

    assert.equal(result.created, true);
    const tenants = await listUserTenants(user.id);
    assert.equal(tenants.length, 1);
    assert.equal(tenants[0].tenantId, result.tenantId);
    assert.equal(tenants[0].role, 'OWNER');
  });

  it('é idempotente: chamar de novo não cria outro tenant', async () => {
    const user = await newUser('Bruno');
    const first = await provisionTenantForUser(user);
    const second = await provisionTenantForUser(user);

    assert.equal(second.created, false);
    assert.equal(second.tenantId, first.tenantId);
    assert.equal((await listUserTenants(user.id)).length, 1);
  });

  it('é seguro sob concorrência (5 chamadas paralelas = 1 tenant)', async () => {
    const user = await newUser('Carla');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => provisionTenantForUser(user)),
    );

    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.tenantId)).size, 1);
    assert.equal((await listUserTenants(user.id)).length, 1);
  });

  it('mantém o isolamento: outro tenant não enxerga a membership', async () => {
    const owner = await newUser('Diego');
    const other = await newUser('Elisa');
    const ownerTenant = await provisionTenantForUser(owner);
    const otherTenant = await provisionTenantForUser(other);

    const seenByOther = await withTenant(otherTenant.tenantId, (tx) => tx.membership.findMany());
    assert.ok(seenByOther.every((m) => m.tenantId === otherTenant.tenantId));
    assert.ok(!seenByOther.some((m) => m.tenantId === ownerTenant.tenantId));
  });

  it('sem app.user_id nem app.tenant_id, nenhuma membership é visível', async () => {
    const rows = await prisma.membership.findMany();
    assert.equal(rows.length, 0);
  });
});
