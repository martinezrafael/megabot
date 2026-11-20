/**
 * Erros do pacote. Quem chama (worker/pg-boss) decide o que fazer olhando `category` e `retryable`,
 * nunca comparando textos de mensagem.
 */
export type AiErrorCategory =
  /** Chave inválida/sem permissão. Exige ação humana. */
  | 'auth'
  /** Limite de taxa do provedor. Repetir depois (veja `retryAfterMs`). */
  | 'rate_limit'
  /** Saldo/cota do provedor esgotados. Exige ação humana; repetir não adianta. */
  | 'quota'
  /** Prompt maior que o contexto do modelo. Reduzir o contexto. */
  | 'context_length'
  /** Bloqueado pela política de conteúdo do provedor. */
  | 'content_filter'
  /** Requisição malformada/modelo inexistente. Bug nosso: não repetir. */
  | 'invalid_request'
  /** Provedor fora do ar ou instável (5xx, rede). Pode repetir. */
  | 'temporary'
  /** Estourou o tempo limite. Pode repetir. */
  | 'timeout'
  /** O provedor respondeu, mas fora do formato esperado (JSON quebrado, tool desconhecida, argumentos inválidos). */
  | 'invalid_response'
  /** Cancelada por quem chamou (ex.: desligamento do worker). */
  | 'aborted'
  /** Configuração ausente/inválida (chave, modelo). */
  | 'configuration'
  | 'unknown';

export interface AiErrorOptions {
  category: AiErrorCategory;
  retryable: boolean;
  httpStatus?: number | undefined;
  /** Código do provedor (ex.: `rate_limit_exceeded`). Seguro para log. */
  providerCode?: string | undefined;
  /** Mensagem do provedor, TRUNCADA. Pode conter trechos do prompt: NUNCA logar nem persistir. */
  providerMessage?: string | undefined;
  /** Quanto esperar antes de repetir (do cabeçalho Retry-After), em ms. */
  retryAfterMs?: number | undefined;
  /** Quantas chamadas HTTP foram feitas até desistir. */
  attempts?: number | undefined;
  cause?: unknown;
}

export class AiError extends Error {
  readonly category: AiErrorCategory;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly providerCode: string | undefined;
  readonly providerMessage: string | undefined;
  readonly retryAfterMs: number | undefined;
  attempts: number | undefined;

  constructor(message: string, options: AiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiError';
    this.category = options.category;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.providerCode = options.providerCode;
    this.providerMessage = options.providerMessage?.slice(0, 300);
    this.retryAfterMs = options.retryAfterMs;
    this.attempts = options.attempts;
  }
}

export interface ProviderErrorInput {
  httpStatus: number;
  /** `error.code` do corpo (ou `error.type`). */
  code?: string | undefined;
  message?: string | undefined;
  retryAfterMs?: number | undefined;
}

const CONTENT_FILTER_CODES = new Set([
  'content_filter',
  'content_policy_violation',
  'invalid_prompt',
]);

/** Traduz a resposta de erro HTTP do provedor para `AiError` (categoria + se vale repetir). */
export function classifyProviderError(input: ProviderErrorInput): AiError {
  const { httpStatus: status, code } = input;
  const base = {
    httpStatus: status,
    providerCode: code,
    providerMessage: input.message,
    retryAfterMs: input.retryAfterMs,
  };
  const make = (message: string, category: AiErrorCategory, retryable: boolean) =>
    new AiError(`${message} (HTTP ${status}${code ? `, ${code}` : ''})`, {
      category,
      retryable,
      ...base,
    });

  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    return make('Cota/saldo do provedor de IA esgotado.', 'quota', false);
  }
  if (code === 'context_length_exceeded') {
    return make('O prompt excede o tamanho de contexto do modelo.', 'context_length', false);
  }
  if (code && CONTENT_FILTER_CODES.has(code)) {
    return make('Conteúdo recusado pela política do provedor de IA.', 'content_filter', false);
  }
  if (status === 401 || status === 403) {
    return make('Chave do provedor de IA inválida ou sem permissão.', 'auth', false);
  }
  if (status === 429) {
    return make('Limite de taxa do provedor de IA atingido.', 'rate_limit', true);
  }
  if (status === 408 || status === 409 || status === 425) {
    return make('Falha temporária no provedor de IA.', 'temporary', true);
  }
  if (status >= 500) {
    return make('Provedor de IA indisponível ou instável.', 'temporary', true);
  }
  if (status >= 400) {
    return make('Requisição inválida para o provedor de IA.', 'invalid_request', false);
  }
  return make('Resposta inesperada do provedor de IA.', 'unknown', false);
}
