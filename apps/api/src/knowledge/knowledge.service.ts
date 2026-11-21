import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  KnowledgeChunkNotFoundError,
  KnowledgeSourceNotFoundError,
  countKnowledgeChunks,
  createKnowledgeSource,
  deleteKnowledgeChunk,
  deleteKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeChunks,
  listKnowledgeSources,
  requestKnowledgeIngestion,
  updateKnowledgeChunkContent,
  type KnowledgeChunkRecord,
  type KnowledgeSourceRecord,
} from '@megabot/database';
import {
  KnowledgeError,
  SUPPORTED_UPLOAD_EXTENSIONS,
  assertHttpUrl,
  assertWithinSize,
  detectFormat,
} from '@megabot/knowledge';
import { StorageError, buildKnowledgeObjectKey } from '@megabot/storage';
import { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../config.tokens';
import { createLogMetrics } from '../whatsapp/log-metrics';

/** Rótulos: tenant_id, kind (upload|url|text), outcome (created|rejected). */
export const KNOWLEDGE_METRIC = {
  sources: 'knowledge_sources_total',
  deletes: 'knowledge_sources_deleted_total',
  chunkEdits: 'knowledge_chunk_edits_total',
} as const;

/** Teto do texto colado: 500 mil caracteres (~250 páginas) já é muito para uma fonte só. */
export const MAX_PASTED_TEXT = 500_000;
export const MAX_CHUNK_CONTENT = 8_000;

export interface UploadInput {
  fileName: string;
  title?: string | undefined;
  mimeType?: string | undefined;
  bytes: Uint8Array;
}

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  get limits() {
    return {
      maxUploadBytes: this.config.knowledge.maxUploadBytes,
      acceptedExtensions: [...SUPPORTED_UPLOAD_EXTENSIONS],
    };
  }

  private count(name: string, tenantId: string, labels: Record<string, string> = {}) {
    createLogMetrics(this.logger).increment(name, { tenant_id: tenantId, ...labels });
  }

  /** Erro do domínio -> resposta HTTP. Mensagens já vêm prontas para o cliente ler. */
  private rethrow(error: unknown): never {
    if (error instanceof KnowledgeError) throw new BadRequestException(error.message);
    if (error instanceof KnowledgeSourceNotFoundError) throw new NotFoundException(error.message);
    if (error instanceof KnowledgeChunkNotFoundError) throw new NotFoundException(error.message);
    if (error instanceof StorageError) {
      if (error.code === 'nao_encontrado') throw new NotFoundException(error.message);
      throw new ServiceUnavailableException(
        error.code === 'configuracao'
          ? 'O armazenamento de arquivos não está configurado no servidor.'
          : 'O armazenamento de arquivos está indisponível. Tente de novo em instantes.',
      );
    }
    throw error;
  }

  list(tenantId: string): Promise<KnowledgeSourceRecord[]> {
    return listKnowledgeSources(tenantId, { limit: 200 });
  }

  async get(tenantId: string, id: string): Promise<KnowledgeSourceRecord> {
    const source = await getKnowledgeSource(tenantId, id);
    if (!source) throw new NotFoundException('Fonte não encontrada.');
    return source;
  }

  /** Importação por URL: só valida a forma aqui; quem baixa (e checa a rede) é o worker. */
  async createFromUrl(
    tenantId: string,
    input: { url: string; title?: string | undefined },
  ): Promise<KnowledgeSourceRecord> {
    let url: URL;
    try {
      url = assertHttpUrl(input.url);
    } catch (error) {
      this.count(KNOWLEDGE_METRIC.sources, tenantId, { kind: 'url', outcome: 'rejected' });
      return this.rethrow(error);
    }
    const source = await createKnowledgeSource(tenantId, {
      kind: 'url',
      title: input.title?.trim() || `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`,
      sourceUrl: url.toString(),
    });
    this.logCreated(source, tenantId);
    return source;
  }

  async createFromText(
    tenantId: string,
    input: { text: string; title?: string | undefined },
  ): Promise<KnowledgeSourceRecord> {
    const text = input.text.trim();
    if (!text) throw new BadRequestException('text: cole algum conteúdo.');
    if (text.length > MAX_PASTED_TEXT) {
      throw new BadRequestException(
        `text: o texto tem ${text.length} caracteres e o limite é ${MAX_PASTED_TEXT}. Divida em fontes menores.`,
      );
    }
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: input.title?.trim() || `${text.slice(0, 60).replace(/\s+/g, ' ')}…`,
      rawText: text,
    });
    this.logCreated(source, tenantId);
    return source;
  }

  /**
   * Upload: valida tipo e tamanho ANTES de guardar, grava no storage e só então cria a fonte.
   * Nessa ordem, nunca sobra uma linha no banco apontando para um arquivo que não existe.
   */
  async createFromUpload(tenantId: string, input: UploadInput): Promise<KnowledgeSourceRecord> {
    const fileName = input.fileName.trim();
    const sourceId = randomUUID();
    let storageKey: string;
    try {
      if (!fileName) throw new BadRequestException('fileName: informe o nome do arquivo.');
      if (input.bytes.byteLength === 0) throw new BadRequestException('O arquivo está vazio.');
      assertWithinSize(input.bytes.byteLength, this.config.knowledge.maxUploadBytes);
      // Lança KnowledgeError('formato_nao_suportado') com a lista do que aceitamos.
      detectFormat({ mimeType: input.mimeType, fileName });
      storageKey = buildKnowledgeObjectKey({ tenantId, sourceId, fileName });
      await this.config.storage.put(storageKey, input.bytes, {
        ...(input.mimeType ? { contentType: input.mimeType } : {}),
      });
    } catch (error) {
      this.count(KNOWLEDGE_METRIC.sources, tenantId, { kind: 'upload', outcome: 'rejected' });
      return this.rethrow(error);
    }

    try {
      const source = await createKnowledgeSource(tenantId, {
        id: sourceId,
        kind: 'upload',
        title: input.title?.trim() || fileName,
        storageKey,
        fileName,
        mimeType: input.mimeType ?? 'application/octet-stream',
        byteSize: input.bytes.byteLength,
      });
      this.logCreated(source, tenantId);
      return source;
    } catch (error) {
      // Não deixa arquivo órfão no storage se o banco recusar a linha.
      await this.config.storage.delete(storageKey).catch(() => undefined);
      return this.rethrow(error);
    }
  }

  private logCreated(source: KnowledgeSourceRecord, tenantId: string) {
    this.count(KNOWLEDGE_METRIC.sources, tenantId, { kind: source.kind, outcome: 'created' });
    this.logger.info(
      {
        event: 'knowledge.source.created',
        tenant_id: tenantId,
        source_id: source.id,
        kind: source.kind,
        byte_size: source.byteSize,
      },
      'Fonte da base de conhecimento criada (aguardando ingestão)',
    );
  }

  async remove(tenantId: string, id: string): Promise<void> {
    let storageKey: string | null;
    try {
      ({ storageKey } = await deleteKnowledgeSource(tenantId, id));
    } catch (error) {
      return this.rethrow(error);
    }
    if (storageKey) {
      // O arquivo é "melhor esforço": a linha já foi apagada e é ela que a tela mostra.
      await this.config.storage.delete(storageKey).catch((error: unknown) => {
        this.logger.warn(
          {
            event: 'knowledge.storage.delete_failed',
            tenant_id: tenantId,
            source_id: id,
            err: String(error),
          },
          'Não foi possível apagar o arquivo no storage',
        );
      });
    }
    this.count(KNOWLEDGE_METRIC.deletes, tenantId);
    this.logger.info(
      { event: 'knowledge.source.deleted', tenant_id: tenantId, source_id: id },
      'Fonte da base de conhecimento apagada',
    );
  }

  /** Reprocessa a fonte do zero (perde edições manuais de trechos, de propósito). */
  async reingest(tenantId: string, id: string): Promise<KnowledgeSourceRecord> {
    const current = await this.get(tenantId, id);
    if (current.status === 'processing') {
      throw new ConflictException('Esta fonte já está sendo processada agora.');
    }
    try {
      const source = await requestKnowledgeIngestion(tenantId, id);
      this.logger.info(
        { event: 'knowledge.source.reingest', tenant_id: tenantId, source_id: id },
        'Reingestão pedida',
      );
      return source;
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async chunks(
    tenantId: string,
    sourceId: string,
    page: { limit: number; offset: number },
  ): Promise<{ total: number; items: KnowledgeChunkRecord[] }> {
    await this.get(tenantId, sourceId); // 404 claro quando a fonte não é do tenant
    const [total, items] = await Promise.all([
      countKnowledgeChunks(tenantId, sourceId),
      listKnowledgeChunks(tenantId, sourceId, page),
    ]);
    return { total, items };
  }

  /** Edição manual: vale na hora; o embedding é recalculado pelo job (modo `stale`). */
  async updateChunk(
    tenantId: string,
    chunkId: string,
    content: string,
  ): Promise<KnowledgeChunkRecord> {
    try {
      const chunk = await updateKnowledgeChunkContent(tenantId, chunkId, content);
      this.count(KNOWLEDGE_METRIC.chunkEdits, tenantId, { action: 'update' });
      this.logger.info(
        {
          event: 'knowledge.chunk.updated',
          tenant_id: tenantId,
          source_id: chunk.sourceId,
          chunk_id: chunk.id,
          char_count: chunk.charCount,
        },
        'Trecho editado (embedding será recalculado)',
      );
      return chunk;
    } catch (error) {
      return this.rethrow(error);
    }
  }

  async removeChunk(tenantId: string, chunkId: string): Promise<void> {
    try {
      const { sourceId } = await deleteKnowledgeChunk(tenantId, chunkId);
      this.count(KNOWLEDGE_METRIC.chunkEdits, tenantId, { action: 'delete' });
      this.logger.info(
        {
          event: 'knowledge.chunk.deleted',
          tenant_id: tenantId,
          source_id: sourceId,
          chunk_id: chunkId,
        },
        'Trecho apagado',
      );
    } catch (error) {
      this.rethrow(error);
    }
  }
}
