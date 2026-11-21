/**
 * Erros da ingestão. O `code` vai para `knowledge_sources.error_code` e a `message` aparece NA TELA
 * para o cliente: por isso ela é em português, explica o que aconteceu e diz o que fazer.
 * `retryable` diz se vale a pena o job tentar de novo (problema passageiro) ou não.
 */
export type KnowledgeErrorCode =
  | 'formato_nao_suportado'
  | 'documento_vazio'
  | 'sem_texto'
  | 'arquivo_grande'
  | 'pdf_invalido'
  | 'planilha_invalida'
  | 'url_invalida'
  | 'url_bloqueada'
  | 'url_inacessivel'
  | 'url_erro_http'
  | 'arquivo_ausente';

export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
    readonly retryable = false,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KnowledgeError';
  }
}

export const knowledgeError = (
  code: KnowledgeErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
) => new KnowledgeError(code, message, retryable, cause === undefined ? {} : { cause });
