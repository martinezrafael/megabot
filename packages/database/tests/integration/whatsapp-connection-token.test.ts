import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';
import {
  LocalKeyring,
  PhoneNumberTakenError,
  TenantNotFoundError,
  TokenCipher,
  TokenCryptoError,
  connectWhatsappNumber,
  getWhatsappAccessToken,
  listWhatsappConnections,
} from '../../src';

const run = randomUUID().slice(0, 8);
const cipher = new TokenCipher(new LocalKeyring({ k1: randomBytes(32) }, 'k1'));
const TOKEN = `EAAG-${run}-token-que-nunca-pode-vazar`;
let seq = 0;
const pn = () => `${Date.now()}${String(++seq).padStart(3, '0')}`;

/** Lê o envelope cru (RLS exige o tenant definido, mesmo em SQL puro). */
const rawEnvelope = (tenantId: string, phoneNumberId: string) =>
  withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ access_token_envelope: string }>
    >`SELECT access_token_envelope FROM whatsapp_connections WHERE phone_number_id = ${phoneNumberId}`;
    return rows;
  });

describe('conexão manual com token cifrado (Postgres real)', () => {
  let a = '';
  let b = '';

  before(async () => {
    const [ta, tb] = await Promise.all([
      prisma.tenant.create({ data: { name: 'C A', slug: `c-a-${run}` } }),
      prisma.tenant.create({ data: { name: 'C B', slug: `c-b-${run}` } }),
    ]);
    a = ta.id;
    b = tb.id;
  });

  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [a, b] } } });
    await prisma.$disconnect();
  });

  it('guarda o token CIFRADO (nunca em texto puro) e devolve só metadados', async () => {
    const phoneNumberId = pn();
    const { connection, created } = await connectWhatsappNumber(
      a,
      { phoneNumberId, wabaId: 'waba-1', accessToken: TOKEN },
      cipher,
    );
    assert.equal(created, true);
    assert.equal(connection.hasToken, true);
    assert.equal(connection.tokenKeyId, 'k1');
    assert.ok(!JSON.stringify(connection).includes(TOKEN));
    assert.ok(!('accessTokenEnvelope' in connection));

    const raw = await rawEnvelope(a, phoneNumberId);
    assert.equal(raw.length, 1);
    assert.ok(!raw[0]!.access_token_envelope.includes(TOKEN));
    assert.ok(raw[0]!.access_token_envelope.startsWith('v1.k1.'));
  });

  it('o token decifra de volta para o tenant dono', async () => {
    const phoneNumberId = pn();
    await connectWhatsappNumber(a, { phoneNumberId, wabaId: 'w', accessToken: TOKEN }, cipher);
    const found = await getWhatsappAccessToken(a, cipher);
    assert.ok(found);
    assert.equal(found.accessToken, TOKEN);
  });

  it('reconectar o mesmo número atualiza (created=false) e troca o token', async () => {
    const phoneNumberId = pn();
    await connectWhatsappNumber(b, { phoneNumberId, wabaId: 'w1', accessToken: 'um' }, cipher);
    const again = await connectWhatsappNumber(
      b,
      { phoneNumberId, wabaId: 'w2', displayPhoneNumber: '+55 11 99999-0000', accessToken: 'dois' },
      cipher,
    );
    assert.equal(again.created, false);
    assert.equal(again.connection.wabaId, 'w2');
    assert.equal((await getWhatsappAccessToken(b, cipher))?.accessToken, 'dois');
    assert.equal((await listWhatsappConnections(b)).length, 1);
  });

  it('número de OUTRO tenant é recusado e o token do dono não muda', async () => {
    const phoneNumberId = pn();
    await connectWhatsappNumber(a, { phoneNumberId, wabaId: 'w', accessToken: 'do-a' }, cipher);
    await assert.rejects(
      connectWhatsappNumber(b, { phoneNumberId, wabaId: 'w', accessToken: 'do-b' }, cipher),
      PhoneNumberTakenError,
    );
    const list = await listWhatsappConnections(a);
    assert.ok(list.some((c) => c.phoneNumberId === phoneNumberId));
    const owner = await getWhatsappAccessToken(a, cipher);
    assert.notEqual(owner?.accessToken, 'do-b');
  });

  it('tenant inexistente → TenantNotFoundError', async () => {
    await assert.rejects(
      connectWhatsappNumber(
        randomUUID(),
        { phoneNumberId: pn(), wabaId: 'w', accessToken: 'x' },
        cipher,
      ),
      TenantNotFoundError,
    );
  });

  it('envelope copiado para OUTRO tenant não abre (AAD amarra tenant e número)', async () => {
    const phoneNumberId = pn();
    await connectWhatsappNumber(a, { phoneNumberId, wabaId: 'w', accessToken: TOKEN }, cipher);
    const [row] = await rawEnvelope(a, phoneNumberId);
    // Simula alguém com acesso ao banco copiando o envelope para a linha de OUTRO tenant.
    const victim = await prisma.tenant.create({ data: { name: 'C D', slug: `c-d-${run}` } });
    try {
      const other = pn();
      await connectWhatsappNumber(
        victim.id,
        { phoneNumberId: other, wabaId: 'w', accessToken: 'x' },
        cipher,
      );
      await withTenant(
        victim.id,
        (tx) =>
          tx.$executeRaw`UPDATE whatsapp_connections SET access_token_envelope = ${row!.access_token_envelope} WHERE phone_number_id = ${other}`,
      );
      await assert.rejects(
        getWhatsappAccessToken(victim.id, cipher),
        (e: unknown) => e instanceof TokenCryptoError && e.code === 'decrypt_failed',
      );
    } finally {
      await prisma.tenant.delete({ where: { id: victim.id } });
    }
  });

  it('conexão antiga sem token → null (cai no token global do worker)', async () => {
    const t = await prisma.tenant.create({ data: { name: 'C C', slug: `c-c-${run}` } });
    try {
      await withTenant(t.id, (tx) =>
        tx.whatsappConnection.create({
          data: { tenantId: t.id, phoneNumberId: pn(), wabaId: 'w' },
        }),
      );
      assert.equal(await getWhatsappAccessToken(t.id, cipher), null);
      const [view] = await listWhatsappConnections(t.id);
      assert.equal(view?.hasToken, false);
    } finally {
      await prisma.tenant.delete({ where: { id: t.id } });
    }
  });
});
