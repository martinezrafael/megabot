import { ApiProperty } from '@nestjs/swagger';

/** Fonte da base de conhecimento, como a API devolve (nunca inclui o texto bruto enviado). */
export class KnowledgeSourceDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;
  @ApiProperty({ type: String, enum: ['upload', 'url', 'text'] })
  kind!: string;
  @ApiProperty({ type: String, example: 'Política de trocas.pdf' })
  title!: string;
  @ApiProperty({
    type: String,
    enum: ['pending', 'processing', 'ready', 'failed'],
    description: 'pending = na fila; processing = em andamento; ready = pronta; failed = falhou',
  })
  status!: string;
  @ApiProperty({ type: Number, example: 40, description: '0 a 100' })
  progress!: number;
  @ApiProperty({ type: String, nullable: true, example: 'https://loja.com.br/trocas' })
  sourceUrl!: string | null;
  @ApiProperty({ type: String, nullable: true })
  fileName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  mimeType!: string | null;
  @ApiProperty({ type: Number, nullable: true })
  byteSize!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Caracteres de texto extraídos' })
  charCount!: number | null;
  @ApiProperty({ type: Number, description: 'Trechos gerados' })
  chunkCount!: number;
  @ApiProperty({ type: String, nullable: true })
  embeddingModel!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastIngestedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'sem_texto',
    description: 'Código do erro da última ingestão',
  })
  errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Erro explicado para quem usa a tela' })
  errorMessage!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class CreateKnowledgeSourceBodyDto {
  @ApiProperty({
    type: String,
    enum: ['url', 'text'],
    description:
      'url = importar de um site; text = colar o conteúdo. Arquivo usa o endpoint /upload.',
  })
  kind!: string;
  @ApiProperty({
    type: String,
    required: false,
    example: 'https://suaempresa.com.br/perguntas-frequentes',
    description: 'Obrigatório quando kind = url. Só http/https e endereços públicos.',
  })
  url?: string;
  @ApiProperty({
    type: String,
    required: false,
    description: 'Obrigatório quando kind = text (o conteúdo colado).',
  })
  text?: string;
  @ApiProperty({
    type: String,
    required: false,
    description: 'Nome que aparece na tela. Sem ele, usamos o endereço ou o começo do texto.',
  })
  title?: string;
}

export class KnowledgeChunkDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;
  @ApiProperty({ type: String, format: 'uuid' })
  sourceId!: string;
  @ApiProperty({ type: Number, description: 'Ordem do trecho na fonte (0, 1, 2...)' })
  position!: number;
  @ApiProperty({ type: String })
  content!: string;
  @ApiProperty({ type: Number })
  charCount!: number;
  @ApiProperty({ type: String, nullable: true, description: 'Seção de origem (ex.: "Página 2")' })
  heading!: string | null;
  @ApiProperty({ type: Boolean, description: 'Já tem embedding gerado' })
  hasEmbedding!: boolean;
  @ApiProperty({ type: String, nullable: true })
  embeddingModel!: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'O texto mudou e o embedding ainda é o antigo (será recalculado)',
  })
  embeddingStale!: boolean;
  @ApiProperty({ type: Boolean, description: 'Editado à mão' })
  edited!: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class UpdateKnowledgeChunkBodyDto {
  @ApiProperty({ type: String, description: 'Novo texto do trecho (1 a 8000 caracteres)' })
  content!: string;
}

export class KnowledgeChunkPageDto {
  @ApiProperty({ type: Number, description: 'Total de trechos da fonte' })
  total!: number;
  @ApiProperty({ type: [KnowledgeChunkDto] })
  items!: KnowledgeChunkDto[];
}

export class KnowledgeLimitsDto {
  @ApiProperty({ type: Number, description: 'Tamanho máximo de upload, em bytes' })
  maxUploadBytes!: number;
  @ApiProperty({
    type: [String],
    example: ['.pdf', '.html', '.txt', '.md', '.csv', '.tsv', '.xlsx'],
  })
  acceptedExtensions!: string[];
}
