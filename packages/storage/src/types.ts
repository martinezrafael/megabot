/**
 * Onde os arquivos enviados para a base de conhecimento ficam guardados.
 *
 * Em produção: Cloudflare R2 (ou qualquer S3). Em desenvolvimento: uma pasta no disco, para
 * `pnpm dev` funcionar sem conta em nuvem nenhuma. Quem usa (API e worker) só conhece esta
 * interface — trocar de provedor não mexe no resto do código.
 */
export interface ObjectStorage {
  /** Nome do driver, para log (`r2`, `s3`, `local`). */
  readonly driver: string;
  put(key: string, bytes: Uint8Array, options?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Apagar algo que não existe NÃO é erro (apagar é idempotente). */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export type StorageErrorCode =
  /** A chave não existe (ou já foi apagada). */
  | 'nao_encontrado'
  /** Configuração ausente ou inválida (bucket, credenciais). */
  | 'configuracao'
  /** Falha de rede/serviço: vale tentar de novo. */
  | 'indisponivel'
  /** Chave fora do padrão (tentativa de sair da pasta, caracteres proibidos). */
  | 'chave_invalida';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly retryable = false,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
  }
}

/** Caracteres aceitos numa chave: pastas com letras, números, ponto, hífen e sublinhado. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

/**
 * Valida a chave antes de qualquer acesso. Barra caminho absoluto, `..`, barras duplas e
 * caracteres estranhos — no driver local isso seria sair da pasta e ler/escrever onde não deve.
 */
export function assertValidKey(key: string): string {
  if (
    !KEY_PATTERN.test(key) ||
    key.includes('..') ||
    key.includes('//') ||
    key.endsWith('/') ||
    key.endsWith('.')
  ) {
    throw new StorageError('chave_invalida', `Chave de arquivo inválida: "${key}".`);
  }
  return key;
}

/** Nome de arquivo seguro e legível (sem acento, espaço nem caractere especial). */
export function slugifyFileName(fileName: string, fallback = 'arquivo'): string {
  const normalized = fileName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  // Só o nome do arquivo interessa: "../../etc/passwd" vira "passwd".
  const baseName =
    normalized
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? '';
  const dot = baseName.lastIndexOf('.');
  const extension = dot > 0 ? baseName.slice(dot + 1) : '';
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;

  const base = stem
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const safeExtension = extension.replace(/[^a-z0-9]/g, '').slice(0, 10);
  return `${base || fallback}${safeExtension ? `.${safeExtension}` : ''}`;
}

/**
 * Chave de um arquivo da base de conhecimento:
 *   `tenants/<tenantId>/knowledge/<sourceId>/<nome-seguro>`
 * O tenant no começo deixa óbvio de quem é o arquivo (e facilita apagar tudo de um cliente).
 */
export function buildKnowledgeObjectKey(input: {
  tenantId: string;
  sourceId: string;
  fileName: string;
}): string {
  return assertValidKey(
    `tenants/${input.tenantId}/knowledge/${input.sourceId}/${slugifyFileName(input.fileName)}`,
  );
}
