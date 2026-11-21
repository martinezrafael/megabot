import { createHash } from 'node:crypto';

/**
 * O pg-boss exige que o id de um job seja um UUID (a coluna é `uuid`): passar "fonte-123" faz o
 * Postgres recusar a inserção. Como a nossa chave de idempotência costuma ser um texto
 * ("<id da fonte>-<quando mudou>"), este ajudante transforma esse texto num UUID determinístico
 * (mesma entrada, sempre o mesmo UUID — é o que faz a deduplicação funcionar).
 *
 * É o esquema do UUID versão 5: SHA-1 do texto, com os bits de versão e variante ajustados.
 */
export function jobIdFor(...parts: Array<string | number>): string {
  const hash = createHash('sha1').update(parts.join('\u0000')).digest();
  // Versão 5 e variante RFC 4122.
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);
