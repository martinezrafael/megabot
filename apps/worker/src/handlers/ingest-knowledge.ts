import { createHash } from 'node:crypto';
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  KnowledgeSourceNotFoundError,
  claimKnowledgeSourceForIngestion,
  createLogMetrics,
  finishKnowledgeSourceIngestion,
  listStaleKnowledgeChunks,
  markKnowledgeSourceFailed,
  replaceKnowledgeChunks,
  setKnowledgeChunkEmbeddings,
  setKnowledgeSourceProgress,
  type KnowledgeSourceWithText,
  type NewKnowledgeChunk,
} from '@megabot/database';
import { AiError, type EmbeddingProvider } from '@megabot/ai';
import {
  DEFAULT_MAX_BYTES,
  KnowledgeError,
  chunkText,
  detectFormat,
  extractDocument,
  fetchRemoteDocument,
  type ChunkOptions,
  type DocumentFormat,
} from '@megabot/knowledge';
import { StorageError, type ObjectStorage } from '@megabot/storage';
import { NonRetryableError, type JobHandler, type QUEUES, type QueueLogger } from '@megabot/queue';

/**
 * Job `knowledge.ingest` (T2.2): transforma uma fonte em trechos pesquisáveis.
 *
 *   fonte (arquivo, URL ou texto) -> texto -> trechos -> embeddings -> knowledge_chunks
 *
 * O caminho é todo observável pela tela: cada passo atualiza `status`/`progress` e, se algo der
 * errado, grava um `error_code` e uma mensagem EM PORTUGUÊS explicando o que fazer.
 *
 * Idempotente: rodar de novo troca todos os trechos da fonte numa transação (nunca sobra meia base).
 *
 * `mode: 'stale'` é o caminho curto: só recalcula o embedding dos trechos editados à mão, sem
 * reprocessar o documento (e sem apagar a edição).
 */

export const INGEST_METRIC = {
  /** Rótulos: tenant_id, kind, outcome (ready|failed|retrying). */
  runs: 'knowledge_ingest_total',
  durationMs: 'knowledge_ingest_duration_ms',
  chunks: 'knowledge_chunks_total',
  staleReembedded: 'knowledge_chunks_reembedded_total',
} as const;

/** Textos por chamada ao provedor de embeddings. */
export const DEFAULT_EMBED_BATCH = 32;

export interface IngestKnowledgeDeps {
  storage: ObjectStorage;
  embedder: EmbeddingProvider;
  /** Injetável nos testes (o padrão baixa da internet de verdade). */
  fetchDocument?: typeof fetchRemoteDocument;
  chunkOptions?: ChunkOptions;
  embedBatchSize?: number;
  maxBytes?: number;
  now?: () => Date;
}

/** Progresso: pesos de cada etapa, para a barra andar de forma honesta. */
const PROGRESS = { claimed: 5, loaded: 20, extracted: 35, chunked: 40, embedded: 95 } as const;

interface LoadedDocument {
  bytes: Uint8Array;
  format: DocumentFormat;
  charset?: string | null;
  fileName?: string | null;
}

/** Carrega o conteúdo da fonte, seja de onde vier. */
async function loadSource(
  source: KnowledgeSourceWithText,
  deps: IngestKnowledgeDeps,
): Promise<LoadedDocument> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  if (source.kind === 'text') {
    const text = source.rawText ?? '';
    return { bytes: new TextEncoder().encode(text), format: 'markdown', fileName: source.title };
  }

  if (source.kind === 'url') {
    const fetchDocument = deps.fetchDocument ?? fetchRemoteDocument;
    const remote = await fetchDocument(source.sourceUrl ?? '', { maxBytes });
    return {
      bytes: remote.bytes,
      format: remote.format,
      charset: remote.charset,
      fileName: remote.fileName,
    };
  }

  // upload
  const key = source.storageKey ?? '';
  const bytes = await deps.storage.get(key);
  return {
    bytes,
    format: detectFormat({ mimeType: source.mimeType, fileName: source.fileName }),
    fileName: source.fileName,
  };
}

/** Erro -> (código, mensagem para a tela, vale repetir?). */
function describeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof KnowledgeError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof StorageError) {
    const message =
      error.code === 'nao_encontrado'
        ? 'O arquivo não está mais no armazenamento. Envie o arquivo de novo.'
        : error.code === 'configuracao'
          ? 'O armazenamento de arquivos não está configurado corretamente no servidor.'
          : 'O armazenamento de arquivos está indisponível. Vamos tentar de novo.';
    return {
      code: error.code === 'nao_encontrado' ? 'arquivo_ausente' : `storage_${error.code}`,
      message,
      retryable: error.retryable,
    };
  }
  if (error instanceof AiError) {
    const messages: Partial<Record<string, string>> = {
      auth: 'A chave do provedor de IA é inválida. Avise o suporte.',
      quota: 'O provedor de IA está sem saldo/cota. Avise o suporte.',
      rate_limit: 'O provedor de IA está limitando o uso agora. Vamos tentar de novo em instantes.',
      timeout: 'O provedor de IA demorou demais para responder. Vamos tentar de novo.',
      context_length: 'Um trecho ficou grande demais para o modelo de embeddings. Avise o suporte.',
      configuration: 'A IA não está configurada no servidor. Avise o suporte.',
    };
    return {
      code: `ia_${error.category}`,
      message:
        messages[error.category] ??
        'Falha ao gerar os embeddings no provedor de IA.' +
          (error.retryable ? ' Vamos tentar de novo.' : ' Avise o suporte.'),
      retryable: error.retryable,
    };
  }
  return {
    code: 'erro_inesperado',
    message: 'Algo deu errado ao processar esta fonte. Já estamos olhando.',
    retryable: true,
  };
}

/** Gera embeddings em lotes, mexendo a barra de progresso entre eles. */
async function embedInBatches(
  texts: readonly string[],
  deps: IngestKnowledgeDeps,
  tenantId: string,
  onProgress: (done: number) => Promise<void>,
): Promise<{ embeddings: number[][]; model: string }> {
  const size = Math.max(deps.embedBatchSize ?? DEFAULT_EMBED_BATCH, 1);
  const embeddings: number[][] = [];
  let model = 'desconhecido';

  for (let start = 0; start < texts.length; start += size) {
    const batch = texts.slice(start, start + size);
    const result = await deps.embedder.embed({
      tenantId,
      input: batch,
      dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
    });
    embeddings.push(...result.embeddings);
    model = result.model;
    await onProgress(embeddings.length);
  }
  return { embeddings, model };
}

export function createIngestKnowledgeHandler(
  deps: IngestKnowledgeDeps,
): JobHandler<typeof QUEUES.knowledgeIngest> {
  const now = deps.now ?? (() => new Date());

  return async ({ payload, logger, attempt, maxAttempts }) => {
    const { tenantId, sourceId, mode } = payload;
    const metrics = createLogMetrics(logger);
    const startedAt = Date.now();

    if (mode === 'stale') {
      await reembedStaleChunks({ tenantId, sourceId, deps, logger, metrics });
      return;
    }

    let source: KnowledgeSourceWithText;
    try {
      source = await claimKnowledgeSourceForIngestion(tenantId, sourceId);
    } catch (error) {
      if (error instanceof KnowledgeSourceNotFoundError) {
        // A fonte foi apagada entre o enfileiramento e agora: nada a fazer.
        logger.info(
          { event: 'knowledge.ingest.skipped', tenant_id: tenantId, source_id: sourceId },
          'Fonte não existe mais; ingestão ignorada',
        );
        return;
      }
      throw error;
    }

    const base = { tenant_id: tenantId, source_id: sourceId, kind: source.kind };
    logger.info(
      { event: 'knowledge.ingest.started', ...base, attempt },
      'Ingestão da fonte iniciada',
    );

    try {
      await setKnowledgeSourceProgress(tenantId, sourceId, PROGRESS.claimed);

      const loaded = await loadSource(source, deps);
      await setKnowledgeSourceProgress(tenantId, sourceId, PROGRESS.loaded);

      const document = await extractDocument({
        bytes: loaded.bytes,
        format: loaded.format,
        fileName: loaded.fileName ?? source.fileName,
        charset: loaded.charset ?? null,
      });
      await setKnowledgeSourceProgress(tenantId, sourceId, PROGRESS.extracted);
      for (const warning of document.warnings) {
        logger.warn({ event: 'knowledge.ingest.warning', ...base, warning }, 'Aviso na extração');
      }

      const drafts = chunkText(document.text, deps.chunkOptions);
      if (drafts.length === 0) {
        throw new KnowledgeError('sem_texto', 'Não encontrei texto para indexar neste documento.');
      }
      await setKnowledgeSourceProgress(tenantId, sourceId, PROGRESS.chunked);

      const { embeddings, model } = await embedInBatches(
        drafts.map((draft) => draft.content),
        deps,
        tenantId,
        async (done) => {
          const span = PROGRESS.embedded - PROGRESS.chunked;
          await setKnowledgeSourceProgress(
            tenantId,
            sourceId,
            PROGRESS.chunked + (span * done) / drafts.length,
          );
        },
      );

      const chunks: NewKnowledgeChunk[] = drafts.map((draft, index) => ({
        position: draft.position,
        content: draft.content,
        heading: draft.heading,
        embedding: embeddings[index] ?? [],
      }));
      await replaceKnowledgeChunks(tenantId, sourceId, chunks, model);

      await finishKnowledgeSourceIngestion(tenantId, sourceId, {
        checksum: createHash('sha256').update(document.text).digest('hex'),
        charCount: document.text.length,
        chunkCount: chunks.length,
        embeddingModel: model,
        embeddingDimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
        now: now(),
      });

      const durationMs = Date.now() - startedAt;
      metrics.increment(INGEST_METRIC.runs, {
        tenant_id: tenantId,
        kind: source.kind,
        outcome: 'ready',
      });
      metrics.increment(INGEST_METRIC.chunks, { tenant_id: tenantId }, chunks.length);
      metrics.increment(INGEST_METRIC.durationMs, { tenant_id: tenantId }, durationMs);
      logger.info(
        {
          event: 'knowledge.ingest.finished',
          ...base,
          chunk_count: chunks.length,
          char_count: document.text.length,
          page_count: document.pageCount,
          embedding_model: model,
          duration_ms: durationMs,
        },
        'Fonte indexada',
      );
    } catch (error) {
      const failure = describeFailure(error);
      const lastAttempt = attempt >= maxAttempts;
      // Enquanto houver tentativa, a tela continua mostrando "processando" (não assusta o cliente
      // com um erro que vai se resolver sozinho). Na última, o erro fica registrado.
      if (!failure.retryable || lastAttempt) {
        await markKnowledgeSourceFailed(tenantId, sourceId, failure).catch(() => undefined);
      }
      metrics.increment(INGEST_METRIC.runs, {
        tenant_id: tenantId,
        kind: source.kind,
        outcome: !failure.retryable || lastAttempt ? 'failed' : 'retrying',
        error_code: failure.code,
      });
      logger.error(
        {
          event: 'knowledge.ingest.failed',
          ...base,
          error_code: failure.code,
          retryable: failure.retryable,
          attempt,
          max_attempts: maxAttempts,
        },
        'Ingestão da fonte falhou',
      );
      if (!failure.retryable) throw new NonRetryableError(failure.message, { cause: error });
      throw error;
    }
  };
}

/** Modo `stale`: só os trechos editados à mão, mantendo o texto do cliente. */
async function reembedStaleChunks(args: {
  tenantId: string;
  sourceId: string;
  deps: IngestKnowledgeDeps;
  logger: QueueLogger;
  metrics: ReturnType<typeof createLogMetrics>;
}): Promise<void> {
  const { tenantId, sourceId, deps, logger, metrics } = args;
  const stale = await listStaleKnowledgeChunks(tenantId, sourceId);
  if (stale.length === 0) return;

  try {
    const { embeddings, model } = await embedInBatches(
      stale.map((chunk) => chunk.content),
      deps,
      tenantId,
      async () => undefined,
    );
    const updated = await setKnowledgeChunkEmbeddings(
      tenantId,
      stale.map((chunk, index) => ({ id: chunk.id, embedding: embeddings[index] ?? [] })),
      model,
    );
    metrics.increment(INGEST_METRIC.staleReembedded, { tenant_id: tenantId }, updated);
    logger.info(
      {
        event: 'knowledge.reembed.finished',
        tenant_id: tenantId,
        source_id: sourceId,
        chunk_count: updated,
        embedding_model: model,
      },
      'Embeddings dos trechos editados recalculados',
    );
  } catch (error) {
    const failure = describeFailure(error);
    logger.error(
      {
        event: 'knowledge.reembed.failed',
        tenant_id: tenantId,
        source_id: sourceId,
        error_code: failure.code,
        retryable: failure.retryable,
      },
      'Falha ao recalcular embeddings dos trechos editados',
    );
    if (!failure.retryable) throw new NonRetryableError(failure.message, { cause: error });
    throw error;
  }
}
