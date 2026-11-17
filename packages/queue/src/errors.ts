/**
 * Erro que NÃO adianta tentar de novo (dado inválido, recurso que não existe, regra de negócio
 * violada...). O worker manda o job direto para a fila de falhas (DLQ), sem gastar as tentativas.
 */
export class NonRetryableError extends Error {
  readonly retryable = false;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

/**
 * Decide se um erro pode ser repetido. Segue o contrato do @megabot/whatsapp: qualquer erro com
 * `retryable === false` (ex.: `WhatsAppApiError` de janela de 24h expirada) é definitivo.
 * Erro desconhecido = repetível (o limite de tentativas protege contra laço infinito).
 */
export function isRetryable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    return (error as { retryable: unknown }).retryable !== false;
  }
  return true;
}

const MAX_MESSAGE_LENGTH = 300;

/** Resumo seguro do erro para log e para a coluna `output` do job (sem stack, tamanho limitado). */
export function describeError(error: unknown): { name: string; message: string; code?: string } {
  const name = error instanceof Error ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.length > MAX_MESSAGE_LENGTH ? `${raw.slice(0, MAX_MESSAGE_LENGTH)}…` : raw;
  const code =
    typeof error === 'object' && error !== null && 'category' in error
      ? String((error as { category: unknown }).category)
      : undefined;
  return code ? { name, message, code } : { name, message };
}
