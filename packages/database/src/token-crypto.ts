import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Criptografia de envelope para segredos de tenant (token de acesso do WhatsApp) — T1.7, ADR 0018.
 *
 *   segredo ──AES-256-GCM(DEK aleatória, uma por segredo)──► texto cifrado
 *   DEK     ──AES-256-GCM(KEK do chaveiro)────────────────► DEK "embrulhada"
 *
 * O que vai para o banco é UMA string com tudo, menos a KEK:
 *   `v1.<kekId>.<dek embrulhada>.<iv>.<tag>.<texto cifrado>`   (partes em base64url)
 *
 * - O AAD (dados autenticados, ex.: `tenant:número`) amarra o segredo à sua linha: copiar o
 *   envelope de um tenant para outro faz a decriptação FALHAR.
 * - Girar a KEK: adicione a nova chave ao chaveiro, torne-a ativa e rode `rewrap`/re-grave; envelopes
 *   antigos continuam legíveis enquanto a chave antiga estiver no chaveiro.
 * - Pronto para KMS: `KeyWrapper` é a única parte que toca na KEK. Trocar o chaveiro local por AWS/GCP
 *   KMS é implementar essa interface (os métodos já são assíncronos).
 */

const VERSION = 'v1';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export class TokenCryptoError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_config' | 'invalid_envelope' | 'unknown_key' | 'decrypt_failed',
  ) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

/** Quem guarda a KEK. Nunca expõe a chave; só embrulha/desembrulha DEKs. */
export interface KeyWrapper {
  /** Id da chave usada para embrulhar novas DEKs. */
  readonly activeKeyId: string;
  wrap(dek: Buffer, aad: Buffer): Promise<{ keyId: string; wrapped: Buffer }>;
  unwrap(keyId: string, wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Chaveiro local: KEKs de 32 bytes vindas do ambiente. Serve para dev e para produção simples. */
export class LocalKeyring implements KeyWrapper {
  private readonly keys: Map<string, Buffer>;
  readonly activeKeyId: string;

  constructor(keys: Record<string, Buffer>, activeKeyId: string) {
    this.keys = new Map(Object.entries(keys));
    for (const [id, key] of this.keys) {
      if (!KEY_ID.test(id)) {
        throw new TokenCryptoError(
          `Id de chave inválido "${id}" (use letras, números, _ ou -, até 32).`,
          'invalid_config',
        );
      }
      if (key.length !== 32) {
        throw new TokenCryptoError(
          `A chave "${id}" precisa ter 32 bytes (256 bits).`,
          'invalid_config',
        );
      }
    }
    if (!this.keys.has(activeKeyId)) {
      throw new TokenCryptoError(
        `A chave ativa "${activeKeyId}" não está no chaveiro.`,
        'invalid_config',
      );
    }
    this.activeKeyId = activeKeyId;
  }

  async wrap(dek: Buffer, aad: Buffer) {
    const key = this.keys.get(this.activeKeyId) as Buffer;
    const { iv, tag, ciphertext } = seal(key, dek, aad);
    return { keyId: this.activeKeyId, wrapped: Buffer.concat([iv, tag, ciphertext]) };
  }

  async unwrap(keyId: string, wrapped: Buffer, aad: Buffer) {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new TokenCryptoError(`Chave "${keyId}" não está no chaveiro.`, 'unknown_key');
    }
    if (wrapped.length < 28) throw new TokenCryptoError('DEK inválida.', 'invalid_envelope');
    return open(key, wrapped.subarray(0, 12), wrapped.subarray(12, 28), wrapped.subarray(28), aad);
  }
}

const b64 = (b: Buffer) => b.toString('base64url');
const fromB64 = (s: string) => Buffer.from(s, 'base64url');

export class TokenCipher {
  constructor(private readonly wrapper: KeyWrapper) {}

  get activeKeyId(): string {
    return this.wrapper.activeKeyId;
  }

  /** Cifra `plaintext`. `aad` amarra o envelope ao seu dono (ex.: `tenantId:phoneNumberId`). */
  async encrypt(plaintext: string, aad: string): Promise<{ envelope: string; keyId: string }> {
    const aadBuf = Buffer.from(aad, 'utf8');
    const dek = randomBytes(32);
    try {
      const { iv, tag, ciphertext } = seal(dek, Buffer.from(plaintext, 'utf8'), aadBuf);
      const { keyId, wrapped } = await this.wrapper.wrap(dek, aadBuf);
      return {
        keyId,
        envelope: [VERSION, keyId, b64(wrapped), b64(iv), b64(tag), b64(ciphertext)].join('.'),
      };
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(envelope: string, aad: string): Promise<string> {
    const parts = envelope.split('.');
    if (parts.length !== 6 || parts[0] !== VERSION) {
      throw new TokenCryptoError('Envelope em formato desconhecido.', 'invalid_envelope');
    }
    const [, keyId, wrapped, iv, tag, ciphertext] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const aadBuf = Buffer.from(aad, 'utf8');
    let dek: Buffer | undefined;
    try {
      dek = await this.wrapper.unwrap(keyId, fromB64(wrapped), aadBuf);
      return open(dek, fromB64(iv), fromB64(tag), fromB64(ciphertext), aadBuf).toString('utf8');
    } catch (error) {
      if (error instanceof TokenCryptoError) throw error;
      // Mensagem fixa de propósito: nada do conteúdo vaza num erro de autenticação.
      throw new TokenCryptoError(
        'Não foi possível decifrar o segredo (chave errada, dado adulterado ou outro dono).',
        'decrypt_failed',
      );
    } finally {
      dek?.fill(0);
    }
  }

  /** Id da KEK usada num envelope (para saber quais precisam de re-criptografia depois de uma rotação). */
  static keyIdOf(envelope: string): string | null {
    const parts = envelope.split('.');
    return parts.length === 6 && parts[0] === VERSION ? (parts[1] ?? null) : null;
  }
}

/**
 * Monta o cifrador a partir do ambiente.
 *   TOKEN_ENCRYPTION_KEYS="k1:<base64 de 32 bytes>[,k2:<...>]"
 *   TOKEN_ENCRYPTION_ACTIVE_KEY_ID="k1"   (opcional se houver só uma chave)
 * Devolve `null` se `TOKEN_ENCRYPTION_KEYS` não estiver definida. Lança `TokenCryptoError` se inválida.
 */
export function createTokenCipherFromEnv(
  env: Record<string, string | undefined> = process.env,
): TokenCipher | null {
  const raw = env.TOKEN_ENCRYPTION_KEYS?.trim();
  if (!raw) return null;
  const keys: Record<string, Buffer> = {};
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (separator < 1 || !value) {
      throw new TokenCryptoError(
        'TOKEN_ENCRYPTION_KEYS: use o formato id:chaveBase64 (separe várias por vírgula).',
        'invalid_config',
      );
    }
    if (id in keys) {
      throw new TokenCryptoError(`TOKEN_ENCRYPTION_KEYS: id "${id}" repetido.`, 'invalid_config');
    }
    keys[id] = Buffer.from(value, 'base64');
  }
  const ids = Object.keys(keys);
  const active = env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID?.trim() || (ids.length === 1 ? ids[0] : '');
  if (!active) {
    throw new TokenCryptoError(
      'Com mais de uma chave, defina TOKEN_ENCRYPTION_ACTIVE_KEY_ID.',
      'invalid_config',
    );
  }
  return new TokenCipher(new LocalKeyring(keys, active));
}

/** AAD usado para o token de um número: amarra o envelope ao tenant E ao número. */
export const whatsappTokenAad = (tenantId: string, phoneNumberId: string) =>
  `whatsapp-token:${tenantId}:${phoneNumberId}`;
