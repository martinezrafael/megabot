/** Utilitários de retentativa (separados para testar sem rede). */

export interface BackoffOptions {
  /** Espera base (ms) antes da 1ª repetição. Dobra a cada tentativa. */
  baseDelayMs: number;
  /** Teto da espera calculada (ms). */
  maxDelayMs: number;
}

/**
 * Backoff exponencial com "jitter total": espera aleatória entre 0 e `min(teto, base * 2^n)`.
 * O jitter evita que várias chamadas falhas repitam todas no mesmo instante.
 * `attempt` começa em 1 (a espera DEPOIS da 1ª falha).
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** `Retry-After` pode ser segundos ("5") ou uma data HTTP. Devolve ms, ou `undefined` se ilegível. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
