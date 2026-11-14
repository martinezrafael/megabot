/**
 * Erros do pacote e mapeamento dos códigos de erro da Meta.
 *
 * Regra de ouro: o chamador (worker/pg-boss) decide o que fazer olhando `category` e `retryable`,
 * nunca comparando strings de mensagem.
 */

export type WhatsAppErrorCategory =
  /** Token inválido/expirado ou sem permissão. Exige ação humana (renovar credencial). */
  | 'auth'
  /** Limite de taxa/vazão. Repetir depois, com espera crescente. */
  | 'rate_limit'
  /** Janela de 24h fechada (131047). Só template é permitido (ADR 0010). */
  | 'window_expired'
  /** Problema com o destinatário (não tem WhatsApp, bloqueou, optou por sair...). Não repetir. */
  | 'recipient'
  /** Template inexistente, pausado, parâmetros errados... */
  | 'template'
  /** Falha de upload/download de mídia. */
  | 'media'
  /** Requisição malformada ou parâmetro inválido. Bug nosso: não adianta repetir. */
  | 'invalid_request'
  /** Conta/número com restrição, pagamento ou registro pendente. Exige ação humana. */
  | 'account'
  /** Falha temporária (Meta fora do ar, timeout, rede). Pode repetir. */
  | 'temporary'
  | 'unknown';

export interface MetaErrorInfo {
  category: WhatsAppErrorCategory;
  retryable: boolean;
  /** Explicação curta em português, para suporte/painel. */
  description: string;
}

const info = (
  category: WhatsAppErrorCategory,
  retryable: boolean,
  description: string,
): MetaErrorInfo => ({ category, retryable, description });

/**
 * Principais códigos de erro da Cloud API.
 * Fonte: documentação de erros da Meta e referências de parceiros (a página oficial não estava
 * acessível ao montar esta tabela). Código desconhecido cai em `classifyMetaError` pelo status HTTP.
 */
const META_ERRORS: Record<number, MetaErrorInfo> = {
  // Autenticação e permissão
  0: info('auth', false, 'Falha de autenticação: token inválido.'),
  3: info('auth', false, 'Capacidade ou permissão ausente para este endpoint.'),
  10: info('auth', false, 'Permissão negada ou removida.'),
  190: info('auth', false, 'Token de acesso expirado ou inválido.'),
  200: info('auth', false, 'Token de acesso ausente ou sem permissão.'),
  131005: info('auth', false, 'Acesso negado ao endpoint.'),

  // Limites
  4: info('rate_limit', true, 'Limite de chamadas do app atingido.'),
  80007: info('rate_limit', true, 'Limite de envio da conta (WABA) atingido.'),
  130429: info('rate_limit', true, 'Vazão máxima de mensagens atingida.'),
  131048: info(
    'rate_limit',
    true,
    'Limite por taxa de spam: muitas mensagens bloqueadas/denunciadas.',
  ),
  131056: info('rate_limit', true, 'Muitas mensagens para o mesmo destinatário em pouco tempo.'),

  // Janela de conversa (ADR 0010)
  131047: info('window_expired', false, 'Fora da janela de 24h: só é possível enviar template.'),

  // Destinatário
  130403: info('recipient', false, 'O contato bloqueou o número da empresa.'),
  130472: info(
    'recipient',
    false,
    'Contato em grupo de controle de experimento da Meta (não é falha).',
  ),
  131021: info('recipient', false, 'Remetente e destinatário são o mesmo número.'),
  131026: info(
    'recipient',
    false,
    'Mensagem não entregável (sem WhatsApp, termos não aceitos ou app desatualizado).',
  ),
  131030: info('recipient', false, 'Destinatário fora da lista permitida (número de teste).'),
  131049: info(
    'recipient',
    false,
    'Meta não entregou para manter a saúde do ecossistema (limite de marketing).',
  ),
  131050: info('recipient', false, 'O contato optou por não receber mensagens de marketing.'),

  // Template
  132000: info('template', false, 'Quantidade de parâmetros diferente da definida no template.'),
  132001: info('template', false, 'Template inexistente ou não aprovado neste idioma.'),
  132005: info('template', false, 'Texto do template, após preencher variáveis, é longo demais.'),
  132007: info('template', false, 'Conteúdo do template viola a política do WhatsApp.'),
  132012: info('template', false, 'Formato de parâmetro diferente do definido no template.'),
  132015: info('template', false, 'Template pausado por baixa qualidade.'),
  132016: info('template', false, 'Template desativado permanentemente por baixa qualidade.'),
  132018: info('template', false, 'Falha de validação dos parâmetros do template.'),
  131063: info('template', false, 'Templates de marketing desativados na Cloud API.'),

  // Mídia
  131052: info('media', false, 'Falha ao baixar a mídia enviada pelo contato.'),
  131053: info('media', false, 'Falha ao subir a mídia (formato ou tamanho inválidos).'),

  // Requisição inválida
  100: info('invalid_request', false, 'Parâmetro inválido, ausente ou grande demais.'),
  131008: info('invalid_request', false, 'Parâmetro obrigatório ausente.'),
  131009: info('invalid_request', false, 'Valor de parâmetro inválido.'),
  131051: info('invalid_request', false, 'Tipo de mensagem não suportado.'),
  135000: info('invalid_request', false, 'Erro genérico em parâmetro da requisição.'),

  // Conta/número
  33: info('account', false, 'O número de telefone da empresa foi excluído.'),
  368: info('account', false, 'Conta temporariamente bloqueada por violação de política.'),
  130497: info('account', false, 'Conta restrita de enviar mensagens para este país.'),
  131031: info('account', false, 'Conta bloqueada.'),
  131037: info('account', false, 'Nome de exibição do número ainda não aprovado.'),
  131042: info(
    'account',
    false,
    'Problema de pagamento (forma de pagamento, limite de crédito, fuso ou moeda).',
  ),
  131045: info('account', false, 'Número com registro incompleto.'),
  131064: info(
    'account',
    false,
    'Limite de mensagens atingido por classificação indevida de templates.',
  ),
  133010: info('account', false, 'Número não registrado na plataforma.'),

  // Temporários
  1: info('temporary', true, 'Erro desconhecido da API (requisição inválida ou falha da Meta).'),
  2: info('temporary', true, 'Serviço da Meta temporariamente indisponível.'),
  131000: info('temporary', true, 'Algo deu errado do lado da Meta.'),
  131016: info('temporary', true, 'Serviço temporariamente indisponível.'),
  131057: info('temporary', true, 'Conta em manutenção.'),
  133004: info('temporary', true, 'Servidor temporariamente indisponível.'),
};

/** Classifica um erro pelo código da Meta; sem código conhecido, usa o status HTTP. */
export function classifyMetaError(code: number | undefined, httpStatus?: number): MetaErrorInfo {
  if (code !== undefined && META_ERRORS[code]) return META_ERRORS[code];
  if (httpStatus === 401) return info('auth', false, 'Não autorizado (HTTP 401).');
  if (httpStatus === 403) return info('account', false, 'Acesso proibido (HTTP 403).');
  if (httpStatus === 429) return info('rate_limit', true, 'Muitas requisições (HTTP 429).');
  if (httpStatus !== undefined && httpStatus >= 500) {
    return info('temporary', true, `Erro do servidor da Meta (HTTP ${httpStatus}).`);
  }
  if (httpStatus === 400 || httpStatus === 404) {
    return info('invalid_request', false, `Requisição rejeitada (HTTP ${httpStatus}).`);
  }
  return info('unknown', false, 'Erro desconhecido.');
}

/** Base de todos os erros do pacote. */
export class WhatsAppError extends Error {
  readonly category: WhatsAppErrorCategory;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { category: WhatsAppErrorCategory; retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.category = options.category;
    this.retryable = options.retryable;
  }
}

/** Entrada inválida detectada ANTES de chamar a Meta (telefone, tamanho, mídia...). */
export class WhatsAppValidationError extends WhatsAppError {
  constructor(message: string) {
    super(message, { category: 'invalid_request', retryable: false });
  }
}

/** Falha de rede ou tempo esgotado: a requisição pode ou não ter chegado à Meta. */
export class WhatsAppNetworkError extends WhatsAppError {
  readonly timedOut: boolean;

  constructor(message: string, options: { timedOut: boolean; cause?: unknown }) {
    super(message, { category: 'temporary', retryable: true, cause: options.cause });
    this.timedOut = options.timedOut;
  }
}

/** A Meta respondeu com erro. Nunca carrega o token. */
export class WhatsAppApiError extends WhatsAppError {
  readonly httpStatus: number;
  /** Código da Meta (ex.: 131047). */
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly details: string | undefined;
  /** Id para abrir chamado na Meta. */
  readonly fbtraceId: string | undefined;
  readonly description: string;

  constructor(args: {
    httpStatus: number;
    code?: number;
    subcode?: number;
    message: string;
    details?: string;
    fbtraceId?: string;
  }) {
    const meta = classifyMetaError(args.code, args.httpStatus);
    super(`WhatsApp API ${args.code ?? args.httpStatus}: ${args.message}`, {
      category: meta.category,
      retryable: meta.retryable,
    });
    this.httpStatus = args.httpStatus;
    this.code = args.code;
    this.subcode = args.subcode;
    this.details = args.details;
    this.fbtraceId = args.fbtraceId;
    this.description = meta.description;
  }
}

/** Converte o corpo de erro do Graph API (`{ error: {...} }`) em `WhatsAppApiError`. */
export function parseGraphError(body: unknown, httpStatus: number): WhatsAppApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  if (!error) {
    return new WhatsAppApiError({
      httpStatus,
      message: `resposta inesperada (HTTP ${httpStatus})`,
    });
  }
  const errorData = isRecord(error.error_data) ? error.error_data : undefined;
  return new WhatsAppApiError({
    httpStatus,
    code: asNumber(error.code),
    subcode: asNumber(error.error_subcode),
    message: typeof error.message === 'string' ? error.message : 'erro sem mensagem',
    details: typeof errorData?.details === 'string' ? errorData.details : undefined,
    fbtraceId: typeof error.fbtrace_id === 'string' ? error.fbtrace_id : undefined,
  });
}

/** Erro que chega DENTRO de um webhook (status `failed`, mensagem `unsupported`, erros de conta). */
export interface WebhookErrorInfo {
  code: number | undefined;
  title: string | undefined;
  message: string | undefined;
  details: string | undefined;
  href: string | undefined;
  category: WhatsAppErrorCategory;
  retryable: boolean;
  description: string;
}

export function mapWebhookError(raw: unknown): WebhookErrorInfo {
  const e = isRecord(raw) ? raw : {};
  const errorData = isRecord(e.error_data) ? e.error_data : undefined;
  const code = asNumber(e.code);
  const meta = classifyMetaError(code);
  return {
    code,
    title: typeof e.title === 'string' ? e.title : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
    details: typeof errorData?.details === 'string' ? errorData.details : undefined,
    href: typeof e.href === 'string' ? e.href : undefined,
    category: meta.category,
    retryable: meta.retryable,
    description: meta.description,
  };
}

export class WebhookPayloadError extends WhatsAppError {
  constructor(message: string) {
    super(message, { category: 'invalid_request', retryable: false });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
