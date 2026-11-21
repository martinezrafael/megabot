import { Prisma } from './generated/prisma/client';
import { withTenant, type TenantTransactionClient } from './tenant-helper';

/**
 * Base de conhecimento (T2.2): fontes e trechos com embeddings no pgvector.
 *
 * Regras que valem para TODAS as funções:
 *  - sempre dentro de `withTenant` (RLS) e com `tenantId` explícito nos filtros;
 *  - o embedding entra e sai em SQL puro: o Prisma não lê nem escreve o tipo `vector`;
 *  - nada de conteúdo de trecho em log (o texto é dado do cliente); só ids e contagens.
 */

/**
 * Dimensão dos embeddings aceita pelo banco — é o `vector(1536)` da migration.
 * O worker pede exatamente esta dimensão ao provedor de IA; trocar o valor exige migration
 * (ALTER TYPE) e reindexar todos os trechos.
 */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

/** Quantos trechos vão em cada INSERT (um statement gigante é pior que alguns médios). */
const INSERT_BATCH = 100;

export type KnowledgeSourceKind = 'upload' | 'url' | 'text';
export type KnowledgeSourceStatus = 'pending' | 'processing' | 'ready' | 'failed';

export class KnowledgeSourceNotFoundError extends Error {
  constructor(id: string) {
    super(`Fonte ${id} não existe nesta empresa.`);
    this.name = 'KnowledgeSourceNotFoundError';
  }
}

export class KnowledgeChunkNotFoundError extends Error {
  constructor(id: string) {
    super(`Trecho ${id} não existe nesta empresa.`);
    this.name = 'KnowledgeChunkNotFoundError';
  }
}

export class EmbeddingDimensionsError extends Error {
  constructor(received: number) {
    super(
      `O embedding tem ${received} dimensões; o banco espera ${KNOWLEDGE_EMBEDDING_DIMENSIONS}.`,
    );
    this.name = 'EmbeddingDimensionsError';
  }
}

export interface KnowledgeSourceRecord {
  id: string;
  tenantId: string;
  kind: KnowledgeSourceKind;
  title: string;
  status: KnowledgeSourceStatus;
  progress: number;
  sourceUrl: string | null;
  storageKey: string | null;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  checksum: string | null;
  charCount: number | null;
  chunkCount: number;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  lastIngestedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Igual ao registro, mais o texto colado (só o worker precisa dele). */
export interface KnowledgeSourceWithText extends KnowledgeSourceRecord {
  rawText: string | null;
}

const SOURCE_SELECT = {
  id: true,
  tenantId: true,
  kind: true,
  title: true,
  status: true,
  progress: true,
  sourceUrl: true,
  storageKey: true,
  fileName: true,
  mimeType: true,
  byteSize: true,
  checksum: true,
  charCount: true,
  chunkCount: true,
  embeddingModel: true,
  embeddingDimensions: true,
  lastIngestedAt: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

type RawSource = { [K in keyof typeof SOURCE_SELECT]: unknown } & { rawText?: unknown };

function toSource(row: RawSource): KnowledgeSourceRecord {
  return {
    ...(row as unknown as KnowledgeSourceRecord),
    kind: row.kind as KnowledgeSourceKind,
    status: row.status as KnowledgeSourceStatus,
  };
}

// ---------------------------------------------------------------------------
// Fontes
// ---------------------------------------------------------------------------

export type CreateKnowledgeSourceInput = { id?: string } & (
  | { kind: 'url'; title: string; sourceUrl: string }
  | { kind: 'text'; title: string; rawText: string }
  | {
      /** O arquivo vai para o storage ANTES da linha existir, por isso o id vem de fora. */
      kind: 'upload';
      title: string;
      storageKey: string;
      fileName: string;
      mimeType: string;
      byteSize: number;
    }
);

/** Cria a fonte com status `pending` (quem a processa é o job `knowledge.ingest`). */
export async function createKnowledgeSource(
  tenantId: string,
  input: CreateKnowledgeSourceInput,
): Promise<KnowledgeSourceRecord> {
  const title = input.title.trim();
  if (!title) throw new Error('title é obrigatório.');
  return withTenant(tenantId, async (tx) => {
    const row = await tx.knowledgeSource.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        tenantId,
        kind: input.kind,
        title,
        status: 'pending',
        progress: 0,
        ...(input.kind === 'url' ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.kind === 'text' ? { rawText: input.rawText } : {}),
        ...(input.kind === 'upload'
          ? {
              storageKey: input.storageKey,
              fileName: input.fileName,
              mimeType: input.mimeType,
              byteSize: input.byteSize,
            }
          : {}),
      },
      select: SOURCE_SELECT,
    });
    return toSource(row);
  });
}

export async function listKnowledgeSources(
  tenantId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<KnowledgeSourceRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.knowledgeSource.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: Math.max(options.offset ?? 0, 0),
      select: SOURCE_SELECT,
    });
    return rows.map(toSource);
  });
}

export function getKnowledgeSource(
  tenantId: string,
  id: string,
): Promise<KnowledgeSourceRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.knowledgeSource.findFirst({
      where: { tenantId, id },
      select: SOURCE_SELECT,
    });
    return row ? toSource(row) : null;
  });
}

/** Com o texto colado: usado só pelo worker, que precisa do conteúdo para extrair. */
export function getKnowledgeSourceForIngestion(
  tenantId: string,
  id: string,
): Promise<KnowledgeSourceWithText | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.knowledgeSource.findFirst({
      where: { tenantId, id },
      select: { ...SOURCE_SELECT, rawText: true },
    });
    return row ? ({ ...toSource(row), rawText: row.rawText } as KnowledgeSourceWithText) : null;
  });
}

/**
 * Marca a fonte como `processing` (progresso 0, erro anterior limpo) e devolve a linha.
 * É o primeiro passo do job: deixa a tela mostrando "processando" mesmo em reprocessamento.
 */
export async function claimKnowledgeSourceForIngestion(
  tenantId: string,
  id: string,
): Promise<KnowledgeSourceWithText> {
  const source = await withTenant(tenantId, async (tx) => {
    const updated = await tx.knowledgeSource.updateMany({
      where: { tenantId, id },
      data: { status: 'processing', progress: 0, errorCode: null, errorMessage: null },
    });
    if (updated.count === 0) return null;
    const row = await tx.knowledgeSource.findFirst({
      where: { tenantId, id },
      select: { ...SOURCE_SELECT, rawText: true },
    });
    return row ? ({ ...toSource(row), rawText: row.rawText } as KnowledgeSourceWithText) : null;
  });
  if (!source) throw new KnowledgeSourceNotFoundError(id);
  return source;
}

/** Atualiza só a barra de progresso (0 a 100). Nunca falha a ingestão por causa disto. */
export async function setKnowledgeSourceProgress(
  tenantId: string,
  id: string,
  progress: number,
): Promise<void> {
  const clamped = Math.min(Math.max(Math.round(progress), 0), 100);
  await withTenant(tenantId, (tx) =>
    tx.knowledgeSource.updateMany({ where: { tenantId, id }, data: { progress: clamped } }),
  );
}

export interface FinishIngestionInput {
  checksum: string;
  charCount: number;
  chunkCount: number;
  embeddingModel: string;
  embeddingDimensions: number;
  now?: Date;
}

/** Fim feliz: `ready`, progresso 100 e os contadores da última ingestão. */
export async function finishKnowledgeSourceIngestion(
  tenantId: string,
  id: string,
  input: FinishIngestionInput,
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.knowledgeSource.updateMany({
      where: { tenantId, id },
      data: {
        status: 'ready',
        progress: 100,
        errorCode: null,
        errorMessage: null,
        checksum: input.checksum,
        charCount: input.charCount,
        chunkCount: input.chunkCount,
        embeddingModel: input.embeddingModel,
        embeddingDimensions: input.embeddingDimensions,
        lastIngestedAt: input.now ?? new Date(),
      },
    }),
  );
}

/** Fim triste: `failed` com código e mensagem LEGÍVEL (a tela mostra isso para o cliente). */
export async function markKnowledgeSourceFailed(
  tenantId: string,
  id: string,
  error: { code: string; message: string },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.knowledgeSource.updateMany({
      where: { tenantId, id },
      data: {
        status: 'failed',
        errorCode: error.code.slice(0, 64),
        errorMessage: error.message.slice(0, 1000),
      },
    }),
  );
}

/** Apaga a fonte (os trechos vão com ela, por cascade) e devolve a chave no storage, se houver. */
export async function deleteKnowledgeSource(
  tenantId: string,
  id: string,
): Promise<{ storageKey: string | null }> {
  const result = await withTenant(tenantId, async (tx) => {
    const row = await tx.knowledgeSource.findFirst({
      where: { tenantId, id },
      select: { id: true, storageKey: true },
    });
    if (!row) return null;
    await tx.knowledgeSource.deleteMany({ where: { tenantId, id } });
    return { storageKey: row.storageKey };
  });
  if (!result) throw new KnowledgeSourceNotFoundError(id);
  return result;
}

/**
 * Coloca a fonte na fila de novo: `pending`, progresso 0 e erro limpo. O relay do worker vê isso e
 * enfileira `knowledge.ingest` (mesmo caminho dos eventos do webhook, T1.7: a API não fala com a fila).
 */
export async function requestKnowledgeIngestion(
  tenantId: string,
  id: string,
): Promise<KnowledgeSourceRecord> {
  const row = await withTenant(tenantId, async (tx) => {
    const updated = await tx.knowledgeSource.updateMany({
      where: { tenantId, id },
      data: { status: 'pending', progress: 0, errorCode: null, errorMessage: null },
    });
    if (updated.count === 0) return null;
    return tx.knowledgeSource.findFirst({ where: { tenantId, id }, select: SOURCE_SELECT });
  });
  if (!row) throw new KnowledgeSourceNotFoundError(id);
  return toSource(row);
}

export interface PendingKnowledgeSource {
  id: string;
  /** Muda a cada novo pedido de ingestão: vira a chave de idempotência do job. */
  updatedAt: Date;
}

/** Fontes esperando ingestão (`pending`). Usado pelo relay do worker. */
export async function listPendingKnowledgeSources(
  tenantId: string,
  limit = 50,
): Promise<PendingKnowledgeSource[]> {
  return withTenant(tenantId, (tx) =>
    tx.knowledgeSource.findMany({
      where: { tenantId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: { id: true, updatedAt: true },
    }),
  );
}

// ---------------------------------------------------------------------------
// Trechos
// ---------------------------------------------------------------------------

export interface NewKnowledgeChunk {
  position: number;
  content: string;
  heading?: string | null;
  /** Vetor com KNOWLEDGE_EMBEDDING_DIMENSIONS números. */
  embedding: readonly number[];
}

export interface KnowledgeChunkRecord {
  id: string;
  sourceId: string;
  position: number;
  content: string;
  charCount: number;
  heading: string | null;
  /** O vetor em si nunca sai daqui: a tela só precisa saber se existe e se está desatualizado. */
  hasEmbedding: boolean;
  embeddingModel: string | null;
  embeddingStale: boolean;
  edited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ChunkRow {
  id: string;
  source_id: string;
  position: number;
  content: string;
  char_count: number;
  heading: string | null;
  has_embedding: boolean;
  embedding_model: string | null;
  embedding_stale: boolean;
  edited: boolean;
  created_at: Date;
  updated_at: Date;
}

const toChunk = (r: ChunkRow): KnowledgeChunkRecord => ({
  id: r.id,
  sourceId: r.source_id,
  position: Number(r.position),
  content: r.content,
  charCount: Number(r.char_count),
  heading: r.heading,
  hasEmbedding: r.has_embedding,
  embeddingModel: r.embedding_model,
  embeddingStale: r.embedding_stale,
  edited: r.edited,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const CHUNK_COLUMNS = Prisma.sql`id, source_id, position, content, char_count, heading,
  (embedding IS NOT NULL) AS has_embedding, embedding_model, embedding_stale, edited,
  created_at, updated_at`;

/** Vetor -> literal do pgvector (`[0.1,0.2]`). Valida tamanho e números antes de chegar ao banco. */
export function toVectorLiteral(embedding: readonly number[]): string {
  if (embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
    throw new EmbeddingDimensionsError(embedding.length);
  }
  for (const value of embedding) {
    if (!Number.isFinite(value))
      throw new Error('O embedding tem valores inválidos (NaN/Infinity).');
  }
  return `[${embedding.join(',')}]`;
}

async function insertChunks(
  tx: TenantTransactionClient,
  tenantId: string,
  sourceId: string,
  chunks: readonly NewKnowledgeChunk[],
  embeddingModel: string,
): Promise<void> {
  for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
    const slice = chunks.slice(start, start + INSERT_BATCH);
    const values = slice.map(
      (chunk) => Prisma.sql`(
        ${tenantId}::uuid, ${sourceId}::uuid, ${chunk.position}::int, ${chunk.content},
        ${chunk.content.length}::int, ${chunk.heading ?? null},
        ${toVectorLiteral(chunk.embedding)}::vector, ${embeddingModel}, false, false, now()
      )`,
    );
    await tx.$executeRaw`
      INSERT INTO knowledge_chunks
        (tenant_id, source_id, position, content, char_count, heading, embedding,
         embedding_model, embedding_stale, edited, updated_at)
      VALUES ${Prisma.join(values)}`;
  }
}

/**
 * Troca TODOS os trechos da fonte pelos novos, numa única transação: ou a base nova entra inteira,
 * ou a antiga continua intacta. É o que torna o job idempotente (rodar duas vezes dá o mesmo
 * resultado) e é também o motivo de uma edição manual ser perdida numa reingestão completa.
 */
export async function replaceKnowledgeChunks(
  tenantId: string,
  sourceId: string,
  chunks: readonly NewKnowledgeChunk[],
  embeddingModel: string,
): Promise<{ inserted: number }> {
  for (const chunk of chunks) toVectorLiteral(chunk.embedding); // valida tudo antes de apagar nada
  return withTenant(tenantId, async (tx) => {
    const exists = await tx.knowledgeSource.findFirst({
      where: { tenantId, id: sourceId },
      select: { id: true },
    });
    if (!exists) throw new KnowledgeSourceNotFoundError(sourceId);
    await tx.$executeRaw`
      DELETE FROM knowledge_chunks WHERE tenant_id = ${tenantId}::uuid AND source_id = ${sourceId}::uuid`;
    if (chunks.length > 0) await insertChunks(tx, tenantId, sourceId, chunks, embeddingModel);
    return { inserted: chunks.length };
  });
}

export async function listKnowledgeChunks(
  tenantId: string,
  sourceId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<KnowledgeChunkRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<ChunkRow[]>`
      SELECT ${CHUNK_COLUMNS}
      FROM knowledge_chunks
      WHERE tenant_id = ${tenantId}::uuid AND source_id = ${sourceId}::uuid
      ORDER BY position
      LIMIT ${limit} OFFSET ${offset}`;
    return rows.map(toChunk);
  });
}

export function countKnowledgeChunks(tenantId: string, sourceId: string): Promise<number> {
  return withTenant(tenantId, (tx) => tx.knowledgeChunk.count({ where: { tenantId, sourceId } }));
}

/**
 * Edição manual de um trecho. O conteúdo novo vale na hora para quem lê a tela, mas o embedding
 * continua sendo o do texto antigo até o job reembeddar: por isso `embedding_stale` fica true.
 */
export async function updateKnowledgeChunkContent(
  tenantId: string,
  chunkId: string,
  content: string,
): Promise<KnowledgeChunkRecord> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('O trecho não pode ficar vazio.');
  const row = await withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<ChunkRow[]>`
      UPDATE knowledge_chunks
      SET content = ${trimmed}, char_count = ${trimmed.length}::int,
          edited = true, embedding_stale = true, updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${chunkId}::uuid
      RETURNING ${CHUNK_COLUMNS}`;
    return rows[0];
  });
  if (!row) throw new KnowledgeChunkNotFoundError(chunkId);
  return toChunk(row);
}

/** Apaga um trecho e acerta o contador da fonte. */
export async function deleteKnowledgeChunk(
  tenantId: string,
  chunkId: string,
): Promise<{ sourceId: string; chunkCount: number }> {
  const result = await withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ source_id: string }>>`
      DELETE FROM knowledge_chunks
      WHERE tenant_id = ${tenantId}::uuid AND id = ${chunkId}::uuid
      RETURNING source_id`;
    const sourceId = rows[0]?.source_id;
    if (!sourceId) return null;
    const chunkCount = await tx.knowledgeChunk.count({ where: { tenantId, sourceId } });
    await tx.knowledgeSource.updateMany({
      where: { tenantId, id: sourceId },
      data: { chunkCount },
    });
    return { sourceId, chunkCount };
  });
  if (!result) throw new KnowledgeChunkNotFoundError(chunkId);
  return result;
}

export interface StaleChunk {
  id: string;
  content: string;
}

/** Trechos editados à mão que ainda esperam um embedding novo. */
export function listStaleKnowledgeChunks(
  tenantId: string,
  sourceId?: string,
  limit = 500,
): Promise<StaleChunk[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; content: string }>>`
      SELECT id, content
      FROM knowledge_chunks
      WHERE tenant_id = ${tenantId}::uuid
        AND embedding_stale
        ${sourceId ? Prisma.sql`AND source_id = ${sourceId}::uuid` : Prisma.empty}
      ORDER BY source_id, position
      LIMIT ${Math.min(Math.max(limit, 1), 2000)}`;
    return rows;
  });
}

export interface SourceWithStaleChunks {
  sourceId: string;
  staleCount: number;
  /** Última edição manual: vira a chave de idempotência do job de reembedding. */
  lastStaleAt: Date;
}

/**
 * Fontes que têm trechos editados à mão esperando um embedding novo. É o que o relay do worker
 * usa para enfileirar `knowledge.ingest` no modo `stale` (sem reprocessar a fonte inteira).
 */
export async function listKnowledgeSourcesWithStaleChunks(
  tenantId: string,
  limit = 20,
): Promise<SourceWithStaleChunks[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ source_id: string; stale_count: bigint; last_stale_at: Date }>
    >`
      SELECT source_id, count(*) AS stale_count, max(updated_at) AS last_stale_at
      FROM knowledge_chunks
      WHERE tenant_id = ${tenantId}::uuid AND embedding_stale
      GROUP BY source_id
      ORDER BY max(updated_at)
      LIMIT ${Math.min(Math.max(limit, 1), 100)}`;
    return rows.map((row) => ({
      sourceId: row.source_id,
      staleCount: Number(row.stale_count),
      lastStaleAt: row.last_stale_at,
    }));
  });
}

/** Grava os embeddings recalculados e limpa `embedding_stale`. */
export async function setKnowledgeChunkEmbeddings(
  tenantId: string,
  updates: ReadonlyArray<{ id: string; embedding: readonly number[] }>,
  embeddingModel: string,
): Promise<number> {
  if (updates.length === 0) return 0;
  const literals = updates.map((u) => ({ id: u.id, vector: toVectorLiteral(u.embedding) }));
  return withTenant(tenantId, async (tx) => {
    let changed = 0;
    for (const { id, vector } of literals) {
      changed += await tx.$executeRaw`
        UPDATE knowledge_chunks
        SET embedding = ${vector}::vector, embedding_model = ${embeddingModel},
            embedding_stale = false, updated_at = now()
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`;
    }
    return changed;
  });
}

export interface KnowledgeSearchHit {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  position: number;
  content: string;
  heading: string | null;
  /** 1 = idêntico, 0 = sem relação (1 menos a distância de cosseno). */
  similarity: number;
}

/**
 * Busca por similaridade (distância de cosseno, índice HNSW). Quem vai usar isto é o agente
 * (Sprint 2); aqui ela também serve de prova de que o pgvector está funcionando ponta a ponta.
 * Só considera fontes `ready` e trechos já embeddados.
 */
export async function searchKnowledgeChunks(
  tenantId: string,
  embedding: readonly number[],
  options: { limit?: number; minSimilarity?: number } = {},
): Promise<KnowledgeSearchHit[]> {
  const vector = toVectorLiteral(embedding);
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 50);
  const minSimilarity = options.minSimilarity ?? 0;
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        chunk_id: string;
        source_id: string;
        source_title: string;
        position: number;
        content: string;
        heading: string | null;
        similarity: number;
      }>
    >`
      SELECT c.id AS chunk_id, c.source_id, s.title AS source_title, c.position, c.content,
             c.heading, 1 - (c.embedding <=> ${vector}::vector) AS similarity
      FROM knowledge_chunks c
      JOIN knowledge_sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
      WHERE c.tenant_id = ${tenantId}::uuid
        AND c.embedding IS NOT NULL
        AND s.status = 'ready'
        AND 1 - (c.embedding <=> ${vector}::vector) >= ${minSimilarity}
      ORDER BY c.embedding <=> ${vector}::vector
      LIMIT ${limit}`;
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      sourceId: r.source_id,
      sourceTitle: r.source_title,
      position: Number(r.position),
      content: r.content,
      heading: r.heading,
      similarity: Number(r.similarity),
    }));
  });
}
