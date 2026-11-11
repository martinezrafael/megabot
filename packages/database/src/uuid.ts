const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Garante que o valor é um UUID válido antes de ele ser usado em set_config().
 * (O valor vai como parâmetro, não concatenado, mas validar cedo gera erros melhores.)
 */
export function assertUuid(value: string, label = 'id'): void {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`Invalid ${label} format: ${value}`);
  }
}
