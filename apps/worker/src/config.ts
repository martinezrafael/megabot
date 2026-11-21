import { AiConfigError, loadAiConfig, type AiConfig } from '@megabot/ai';
import { TokenCryptoError, createTokenCipherFromEnv, type TokenCipher } from '@megabot/database';
import { DEFAULT_MAX_BYTES } from '@megabot/knowledge';
import { StorageError, createStorageFromEnv, type ObjectStorage } from '@megabot/storage';
import { z } from 'zod';

/**
 * Configuração do worker, validada com Zod na inicialização ("falha rápida", como na API):
 * todos os problemas são listados de uma vez e o processo não sobe.
 */
export interface WorkerConfig {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Conexões do pool do pg-boss neste processo. */
  poolSize: number;
  /** De quanto em quanto tempo olhar as filas, em segundos. */
  pollIntervalSeconds: number;
  /** Tempo máximo esperando jobs em andamento terminarem ao desligar. */
  shutdownTimeoutMs: number;
  /** Schema do pg-boss (padrão `pgboss`; só os testes mudam). */
  queueSchema: string;
  whatsapp: {
    /** Token da Cloud API. Sem ele o worker NÃO processa `whatsapp.outbound` (os jobs esperam na fila). */
    accessToken: string | undefined;
    /** Só para testes/sandbox; padrão: graph.facebook.com. */
    baseUrl: string | undefined;
    /** Mensagens por segundo por número (padrão 80, o limite inicial da Meta). */
    ratePerSecond: number;
    /** Quanto o job espera por uma vaga do rate limit antes de devolver à fila (ms). */
    rateLimitMaxWaitMs: number;
  };
  /**
   * Cifrador dos tokens por número (T1.7, ADR 0018). Com ele, cada envio usa o token do PRÓPRIO
   * número (decifrado na hora). `null` = só o token global `WHATSAPP_API_TOKEN` (legado/dev).
   */
  tokenCipher: TokenCipher | null;
  /** De quanto em quanto tempo enfileirar eventos do webhook ainda `pending` (0 = desligado). */
  inboxRelayIntervalMs: number;
  /** Eco: responde "Eco: <texto>" a cada mensagem recebida (validação da T1.7). NUNCA em produção. */
  echoEnabled: boolean;
  /**
   * Provedor de IA (T2.1). `null` = nada configurado: a fila `knowledge.ingest` NÃO é processada
   * (os jobs esperam) em vez de falhar tudo por falta de chave.
   */
  ai: AiConfig | null;
  /** Onde ficam os arquivos enviados para a base de conhecimento (R2/S3 ou disco). */
  storage: ObjectStorage;
  knowledge: {
    /** Tamanho máximo de um documento lido (arquivo ou página), em bytes. */
    maxBytes: number;
    /** Tamanho máximo de um trecho, em caracteres. */
    chunkMaxChars: number;
    /** Sobreposição entre trechos vizinhos, em caracteres. */
    chunkOverlapChars: number;
    /** Trechos por chamada ao provedor de embeddings. */
    embedBatchSize: number;
  };
}

export class WorkerConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Configuração do worker inválida. Corrija o .env e tente de novo:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'WorkerConfigError';
  }
}

const positiveInt = z.coerce.number({ error: 'precisa ser um número' }).int().positive();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z
    .string({ error: 'obrigatória' })
    .regex(/^postgres(ql)?:\/\//, 'precisa começar com postgresql://'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  WORKER_POOL_SIZE: positiveInt.max(50).default(4),
  WORKER_POLL_INTERVAL_SECONDS: z.coerce.number().min(0.5).max(60).default(2),
  WORKER_SHUTDOWN_TIMEOUT_SECONDS: positiveInt.max(600).default(30),
  QUEUE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'use só letras minúsculas, números e _')
    .default('pgboss'),
  WHATSAPP_API_TOKEN: z.string().min(1).optional(),
  WHATSAPP_API_BASE_URL: z.url({ error: 'precisa ser uma URL' }).optional(),
  WHATSAPP_RATE_LIMIT_PER_SECOND: z.coerce.number().positive().max(1000).default(80),
  WHATSAPP_RATE_LIMIT_MAX_WAIT_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
  WORKER_INBOX_RELAY_INTERVAL_SECONDS: z.coerce.number().min(0).max(3600).optional(),
  WORKER_ECHO_ENABLED: z.enum(['true', 'false']).default('false'),
  KNOWLEDGE_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  KNOWLEDGE_CHUNK_MAX_CHARS: z.coerce.number().int().min(200).max(8000).default(1200),
  KNOWLEDGE_CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).max(2000).default(150),
  KNOWLEDGE_EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(32),
});

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // Variável vazia (`LOG_LEVEL=`) conta como "não definida".
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new WorkerConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(geral)'}: ${i.message}`),
    );
  }
  const e = parsed.data;

  let tokenCipher: TokenCipher | null = null;
  try {
    tokenCipher = createTokenCipherFromEnv(cleaned);
  } catch (error) {
    if (!(error instanceof TokenCryptoError)) throw error;
    throw new WorkerConfigError([`TOKEN_ENCRYPTION_KEYS: ${error.message}`]);
  }
  if (e.NODE_ENV === 'production' && e.WORKER_ECHO_ENABLED === 'true') {
    throw new WorkerConfigError(['WORKER_ECHO_ENABLED: o eco não pode ficar ligado em produção']);
  }

  // IA: nada configurado -> null (a fila da base de conhecimento fica parada, com aviso no log).
  // Configuração PELA METADE -> erro na subida, para um nome de modelo errado não passar batido.
  const aiTouched = Boolean(
    cleaned.OPENAI_API_KEY || cleaned.AI_CHAT_MODEL || cleaned.AI_EMBEDDING_MODEL,
  );
  let ai: AiConfig | null = null;
  if (aiTouched) {
    try {
      ai = loadAiConfig(cleaned);
    } catch (error) {
      if (!(error instanceof AiConfigError)) throw error;
      throw new WorkerConfigError(error.issues);
    }
  }

  let storage: ObjectStorage;
  try {
    storage = createStorageFromEnv(cleaned);
  } catch (error) {
    if (!(error instanceof StorageError)) throw error;
    throw new WorkerConfigError([error.message]);
  }

  return {
    env: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    poolSize: e.WORKER_POOL_SIZE,
    pollIntervalSeconds: e.WORKER_POLL_INTERVAL_SECONDS,
    shutdownTimeoutMs: e.WORKER_SHUTDOWN_TIMEOUT_SECONDS * 1000,
    queueSchema: e.QUEUE_SCHEMA,
    whatsapp: {
      accessToken: e.WHATSAPP_API_TOKEN,
      baseUrl: e.WHATSAPP_API_BASE_URL,
      ratePerSecond: e.WHATSAPP_RATE_LIMIT_PER_SECOND,
      rateLimitMaxWaitMs: e.WHATSAPP_RATE_LIMIT_MAX_WAIT_MS,
    },
    tokenCipher,
    // Padrão: 5 s (0 nos testes, para não enfileirar eventos de outros testes).
    inboxRelayIntervalMs:
      (e.WORKER_INBOX_RELAY_INTERVAL_SECONDS ?? (e.NODE_ENV === 'test' ? 0 : 5)) * 1000,
    echoEnabled: e.WORKER_ECHO_ENABLED === 'true',
    ai,
    storage,
    knowledge: {
      maxBytes: Math.min(e.KNOWLEDGE_MAX_UPLOAD_MB * 1024 * 1024, DEFAULT_MAX_BYTES * 5),
      chunkMaxChars: e.KNOWLEDGE_CHUNK_MAX_CHARS,
      chunkOverlapChars: e.KNOWLEDGE_CHUNK_OVERLAP_CHARS,
      embedBatchSize: e.KNOWLEDGE_EMBED_BATCH_SIZE,
    },
  };
}
