import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  LocalKeyring,
  TokenCipher,
  TokenCryptoError,
  createTokenCipherFromEnv,
  whatsappTokenAad,
} from '../src/token-crypto';

const key = () => randomBytes(32);
const cipherWith = (keys: Record<string, Buffer>, active: string) =>
  new TokenCipher(new LocalKeyring(keys, active));
const SECRET = 'EAAG-segredo-super-secreto-123';
const AAD = whatsappTokenAad('11111111-1111-4111-8111-111111111111', '1065403522');

describe('criptografia de envelope (T1.7)', () => {
  it('cifra e decifra (ida e volta) e o envelope não contém o texto puro', async () => {
    const c = cipherWith({ k1: key() }, 'k1');
    const { envelope, keyId } = await c.encrypt(SECRET, AAD);
    assert.equal(keyId, 'k1');
    assert.ok(!envelope.includes(SECRET));
    assert.ok(!Buffer.from(envelope).toString('base64').includes(SECRET));
    assert.equal(await c.decrypt(envelope, AAD), SECRET);
  });

  it('cada cifragem é diferente (DEK e iv aleatórios)', async () => {
    const c = cipherWith({ k1: key() }, 'k1');
    const a = await c.encrypt(SECRET, AAD);
    const b = await c.encrypt(SECRET, AAD);
    assert.notEqual(a.envelope, b.envelope);
  });

  it('AAD diferente (outro tenant/número) falha', async () => {
    const c = cipherWith({ k1: key() }, 'k1');
    const { envelope } = await c.encrypt(SECRET, AAD);
    await assert.rejects(
      c.decrypt(envelope, whatsappTokenAad('22222222-2222-4222-8222-222222222222', '1065403522')),
      (e: unknown) => e instanceof TokenCryptoError && e.code === 'decrypt_failed',
    );
  });

  it('adulteração de qualquer parte é detectada, e o erro não vaza o segredo', async () => {
    const c = cipherWith({ k1: key() }, 'k1');
    const { envelope } = await c.encrypt(SECRET, AAD);
    const parts = envelope.split('.');
    for (const index of [2, 3, 4, 5]) {
      const copy = [...parts];
      const buf = Buffer.from(copy[index] as string, 'base64url');
      buf[0] = (buf[0] as number) ^ 0xff;
      copy[index] = buf.toString('base64url');
      await assert.rejects(c.decrypt(copy.join('.'), AAD), (e: unknown) => {
        assert.ok(e instanceof TokenCryptoError);
        assert.ok(!e.message.includes(SECRET));
        return true;
      });
    }
  });

  it('chave errada falha; formato desconhecido falha', async () => {
    const a = cipherWith({ k1: key() }, 'k1');
    const b = cipherWith({ k1: key() }, 'k1');
    const { envelope } = await a.encrypt(SECRET, AAD);
    await assert.rejects(b.decrypt(envelope, AAD), { code: 'decrypt_failed' });
    await assert.rejects(a.decrypt('lixo', AAD), { code: 'invalid_envelope' });
    await assert.rejects(a.decrypt(envelope.replace(/^v1/, 'v9'), AAD), {
      code: 'invalid_envelope',
    });
  });

  it('rotação: envelope antigo continua legível; novos usam a chave ativa', async () => {
    const k1 = key();
    const k2 = key();
    const old = await cipherWith({ k1 }, 'k1').encrypt(SECRET, AAD);
    const rotated = cipherWith({ k1, k2 }, 'k2');
    assert.equal(await rotated.decrypt(old.envelope, AAD), SECRET);
    const fresh = await rotated.encrypt(SECRET, AAD);
    assert.equal(fresh.keyId, 'k2');
    assert.equal(TokenCipher.keyIdOf(fresh.envelope), 'k2');
    assert.equal(TokenCipher.keyIdOf(old.envelope), 'k1');
    // Sem a chave antiga no chaveiro, o envelope antigo não abre.
    await assert.rejects(cipherWith({ k2 }, 'k2').decrypt(old.envelope, AAD), {
      code: 'unknown_key',
    });
  });

  it('valida o chaveiro: tamanho da chave, id inválido, chave ativa ausente', () => {
    assert.throws(() => new LocalKeyring({ k1: randomBytes(16) }, 'k1'), /32 bytes/);
    assert.throws(() => new LocalKeyring({ 'a.b': key() }, 'a.b'), /Id de chave/);
    assert.throws(() => new LocalKeyring({ k1: key() }, 'k2'), /chave ativa/);
  });

  it('createTokenCipherFromEnv: lê o ambiente', async () => {
    assert.equal(createTokenCipherFromEnv({}), null);
    const k = randomBytes(32).toString('base64');
    const one = createTokenCipherFromEnv({ TOKEN_ENCRYPTION_KEYS: `a:${k}` });
    assert.equal(one?.activeKeyId, 'a');
    const two = createTokenCipherFromEnv({
      TOKEN_ENCRYPTION_KEYS: `a:${k},b:${randomBytes(32).toString('base64')}`,
      TOKEN_ENCRYPTION_ACTIVE_KEY_ID: 'b',
    });
    assert.equal(two?.activeKeyId, 'b');
    assert.throws(
      () =>
        createTokenCipherFromEnv({
          TOKEN_ENCRYPTION_KEYS: `a:${k},b:${randomBytes(32).toString('base64')}`,
        }),
      /TOKEN_ENCRYPTION_ACTIVE_KEY_ID/,
    );
    assert.throws(
      () => createTokenCipherFromEnv({ TOKEN_ENCRYPTION_KEYS: 'semformato' }),
      /id:chave/,
    );
    assert.throws(
      () => createTokenCipherFromEnv({ TOKEN_ENCRYPTION_KEYS: `a:${k},a:${k}` }),
      /repetido/,
    );
    assert.throws(() => createTokenCipherFromEnv({ TOKEN_ENCRYPTION_KEYS: 'a:curta' }), /32 bytes/);
  });
});
