import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { KnowledgeChunkRecord, KnowledgeSourceRecord } from '@megabot/database';
import type { Request } from 'express';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../auth/auth.context';
import { ErrorResponseDto } from '../common/error-response.dto';
import { parseOrBadRequest } from '../common/parse-or-bad-request';
import {
  CreateKnowledgeSourceBodyDto,
  KnowledgeChunkDto,
  KnowledgeChunkPageDto,
  KnowledgeLimitsDto,
  KnowledgeSourceDto,
  UpdateKnowledgeChunkBodyDto,
} from './knowledge.dto';
import { KnowledgeService, MAX_CHUNK_CONTENT } from './knowledge.service';

const createBody = z
  .strictObject({
    kind: z.enum(['url', 'text'], { error: 'use "url" ou "text"' }),
    url: z.string().trim().min(1).max(2048).optional(),
    text: z.string().max(1_000_000).optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine((body) => (body.kind === 'url' ? Boolean(body.url) : Boolean(body.text)), {
    error: 'informe "url" (kind=url) ou "text" (kind=text)',
  });

const uploadQuery = z.object({
  fileName: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(200).optional(),
});

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const chunkBody = z.strictObject({
  content: z.string().trim().min(1, 'não pode ficar vazio').max(MAX_CHUNK_CONTENT),
});

const uuid = z.uuid({ error: 'id inválido' });

const toSourceDto = (source: KnowledgeSourceRecord): KnowledgeSourceDto => ({
  id: source.id,
  kind: source.kind,
  title: source.title,
  status: source.status,
  progress: source.progress,
  sourceUrl: source.sourceUrl,
  fileName: source.fileName,
  mimeType: source.mimeType,
  byteSize: source.byteSize,
  charCount: source.charCount,
  chunkCount: source.chunkCount,
  embeddingModel: source.embeddingModel,
  lastIngestedAt: source.lastIngestedAt?.toISOString() ?? null,
  errorCode: source.errorCode,
  errorMessage: source.errorMessage,
  createdAt: source.createdAt.toISOString(),
  updatedAt: source.updatedAt.toISOString(),
});

const toChunkDto = (chunk: KnowledgeChunkRecord): KnowledgeChunkDto => ({
  id: chunk.id,
  sourceId: chunk.sourceId,
  position: chunk.position,
  content: chunk.content,
  charCount: chunk.charCount,
  heading: chunk.heading,
  hasEmbedding: chunk.hasEmbedding,
  embeddingModel: chunk.embeddingModel,
  embeddingStale: chunk.embeddingStale,
  edited: chunk.edited,
  updatedAt: chunk.updatedAt.toISOString(),
});

/**
 * Base de conhecimento do tenant logado (T2.2).
 *
 * Todas as rotas exigem sessão (AuthGuard global) e trabalham SEMPRE no tenant de quem está
 * logado — o `tenantId` nunca vem do corpo ou da URL, então um cliente não consegue nem tentar
 * mexer na base de outro.
 */
@ApiTags('knowledge')
@ApiCookieAuth('session')
@Controller('knowledge')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Sem sessão válida' })
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly service: KnowledgeService) {}

  /** O tenant sai da sessão; sem tenant (provisionamento incompleto) a base não existe. */
  private tenantOf(auth: AuthContext): string {
    if (!auth.tenantId) {
      throw new ForbiddenException('Sua conta ainda não tem uma empresa associada.');
    }
    return auth.tenantId;
  }

  @Get('limits')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Limites de upload (tamanho e extensões aceitas)' })
  @ApiOkResponse({ type: KnowledgeLimitsDto })
  limits(): KnowledgeLimitsDto {
    return this.service.limits;
  }

  @Get('sources')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Fontes da base de conhecimento, da mais nova para a mais antiga' })
  @ApiOkResponse({ type: [KnowledgeSourceDto] })
  async listSources(@CurrentAuth() auth: AuthContext): Promise<KnowledgeSourceDto[]> {
    const sources = await this.service.list(this.tenantOf(auth));
    return sources.map(toSourceDto);
  }

  @Post('sources')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Criar fonte a partir de uma URL ou de texto colado',
    description:
      'A fonte nasce com status `pending`; o worker processa em segundos (extrai, divide e gera embeddings).',
  })
  @ApiBody({ type: CreateKnowledgeSourceBodyDto })
  @ApiCreatedResponse({ type: KnowledgeSourceDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Corpo inválido ou URL recusada',
  })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'Conta sem empresa associada' })
  async createSource(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<KnowledgeSourceDto> {
    const tenantId = this.tenantOf(auth);
    const input = parseOrBadRequest(createBody, body);
    const source =
      input.kind === 'url'
        ? await this.service.createFromUrl(tenantId, { url: input.url!, title: input.title })
        : await this.service.createFromText(tenantId, { text: input.text!, title: input.title });
    return toSourceDto(source);
  }

  /**
   * Upload do arquivo em si. O corpo é o ARQUIVO CRU (sem multipart): o nome vai na query e o
   * tipo no Content-Type. Do navegador é só `fetch(url, { method: 'POST', body: file })`.
   */
  @Post('sources/upload')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Enviar um arquivo (PDF, HTML, texto, CSV/TSV ou XLSX)',
    description:
      'O corpo da requisição é o conteúdo do arquivo (bytes), não multipart. Informe `fileName` na query ' +
      'e o tipo em `Content-Type`. Limite e extensões aceitas vêm de `GET /knowledge/limits`.',
  })
  @ApiConsumes('application/octet-stream', 'application/pdf', 'text/csv', 'text/plain')
  @ApiQuery({ name: 'fileName', required: true, example: 'politica-de-trocas.pdf' })
  @ApiQuery({ name: 'title', required: false })
  @ApiBody({ description: 'Bytes do arquivo', schema: { type: 'string', format: 'binary' } })
  @ApiCreatedResponse({ type: KnowledgeSourceDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Arquivo vazio, grande demais ou de formato não suportado',
  })
  @ApiResponse({ status: 413, type: ErrorResponseDto, description: 'Arquivo maior que o limite' })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: 'Armazenamento indisponível ou não configurado',
  })
  async upload(
    @CurrentAuth() auth: AuthContext,
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
  ): Promise<KnowledgeSourceDto> {
    const tenantId = this.tenantOf(auth);
    const { fileName, title } = parseOrBadRequest(uploadQuery, query);
    const body = request.body;
    const bytes = Buffer.isBuffer(body) ? new Uint8Array(body) : new Uint8Array();
    const source = await this.service.createFromUpload(tenantId, {
      fileName,
      title,
      mimeType: request.header('content-type')?.split(';')[0]?.trim(),
      bytes,
    });
    return toSourceDto(source);
  }

  @Get('sources/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Uma fonte (status, progresso, erro)' })
  @ApiOkResponse({ type: KnowledgeSourceDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Fonte não encontrada' })
  async getSource(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<KnowledgeSourceDto> {
    const source = await this.service.get(this.tenantOf(auth), parseOrBadRequest(uuid, id));
    return toSourceDto(source);
  }

  @Delete('sources/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Apagar a fonte, seus trechos e o arquivo guardado' })
  @ApiResponse({ status: 204, description: 'Apagada' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Fonte não encontrada' })
  async deleteSource(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    await this.service.remove(this.tenantOf(auth), parseOrBadRequest(uuid, id));
  }

  @Post('sources/:id/reingest')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Processar a fonte de novo',
    description:
      'Refaz extração, divisão e embeddings. Edições manuais de trechos são descartadas.',
  })
  @ApiOkResponse({ type: KnowledgeSourceDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Fonte não encontrada' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'Já está processando' })
  async reingest(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<KnowledgeSourceDto> {
    const source = await this.service.reingest(this.tenantOf(auth), parseOrBadRequest(uuid, id));
    return toSourceDto(source);
  }

  @Get('sources/:id/chunks')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Trechos gerados a partir da fonte' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ type: KnowledgeChunkPageDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Fonte não encontrada' })
  async listChunks(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<KnowledgeChunkPageDto> {
    const page = parseOrBadRequest(pageQuery, query);
    const { total, items } = await this.service.chunks(
      this.tenantOf(auth),
      parseOrBadRequest(uuid, id),
      page,
    );
    return { total, items: items.map(toChunkDto) };
  }

  @Patch('chunks/:chunkId')
  @ApiOperation({
    summary: 'Editar o texto de um trecho',
    description:
      'O texto novo vale na hora. O embedding é recalculado pelo worker em seguida (enquanto isso, ' +
      '`embeddingStale` fica true).',
  })
  @ApiBody({ type: UpdateKnowledgeChunkBodyDto })
  @ApiOkResponse({ type: KnowledgeChunkDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Conteúdo inválido' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Trecho não encontrado' })
  async updateChunk(
    @CurrentAuth() auth: AuthContext,
    @Param('chunkId') chunkId: string,
    @Body() body: unknown,
  ): Promise<KnowledgeChunkDto> {
    const { content } = parseOrBadRequest(chunkBody, body);
    const chunk = await this.service.updateChunk(
      this.tenantOf(auth),
      parseOrBadRequest(uuid, chunkId),
      content,
    );
    return toChunkDto(chunk);
  }

  @Delete('chunks/:chunkId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Apagar um trecho' })
  @ApiResponse({ status: 204, description: 'Apagado' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Trecho não encontrado' })
  async deleteChunk(
    @CurrentAuth() auth: AuthContext,
    @Param('chunkId') chunkId: string,
  ): Promise<void> {
    await this.service.removeChunk(this.tenantOf(auth), parseOrBadRequest(uuid, chunkId));
  }
}
