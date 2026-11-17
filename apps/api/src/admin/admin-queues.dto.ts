import { ApiProperty } from '@nestjs/swagger';

const JOB_STATES = ['created', 'retry', 'active', 'completed', 'cancelled', 'failed'];

export class QueueConfigDto {
  @ApiProperty({ type: Number, description: 'Retentativas depois da primeira execução' })
  retryLimit!: number;
  @ApiProperty({ type: Number })
  retryDelaySeconds!: number;
  @ApiProperty({ type: Boolean, description: 'Espera exponencial entre tentativas' })
  retryBackoff!: boolean;
  @ApiProperty({ type: Number, nullable: true })
  retryDelayMaxSeconds!: number | null;
  @ApiProperty({ type: Number, description: 'Tempo máximo de uma execução' })
  expireInSeconds!: number;
}

export class QueueCountsDto {
  @ApiProperty({ type: Number, description: 'Esperando para executar (inclui agendados)' })
  created!: number;
  @ApiProperty({ type: Number, description: 'Falhou e aguarda a próxima tentativa' })
  retry!: number;
  @ApiProperty({ type: Number, description: 'Em execução agora' })
  active!: number;
  @ApiProperty({ type: Number })
  completed!: number;
  @ApiProperty({ type: Number })
  cancelled!: number;
  @ApiProperty({ type: Number, description: 'Falhou de vez (foi para a DLQ, se houver)' })
  failed!: number;
  @ApiProperty({ type: Number, description: 'Parte de "created" agendada para o futuro' })
  deferred!: number;
}

export class QueueOverviewDto {
  @ApiProperty({ type: String, example: 'whatsapp.inbound' })
  name!: string;
  @ApiProperty({ type: Boolean, description: 'Fila de falhas (DLQ)' })
  isDeadLetter!: boolean;
  @ApiProperty({ type: String, nullable: true, example: 'whatsapp.inbound.dlq' })
  deadLetterName!: string | null;
  @ApiProperty({ type: () => QueueConfigDto })
  config!: QueueConfigDto;
  @ApiProperty({ type: () => QueueCountsDto })
  counts!: QueueCountsDto;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Há quantos segundos o job pronto mais antigo espera (null = ninguém esperando)',
  })
  oldestWaitingSeconds!: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastCompletedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastFailedAt!: string | null;
}

export class QueuesSnapshotDto {
  @ApiProperty({
    type: Boolean,
    description: 'false = o worker ainda não criou as tabelas do pg-boss',
  })
  installed!: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt!: string;
  @ApiProperty({ type: () => [QueueOverviewDto] })
  queues!: QueueOverviewDto[];
}

export class JobSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;
  @ApiProperty({ type: String })
  queue!: string;
  @ApiProperty({ type: String, enum: JOB_STATES })
  state!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Empresa dona do job' })
  tenantId!: string | null;
  @ApiProperty({ type: Number })
  retryCount!: number;
  @ApiProperty({ type: Number })
  retryLimit!: number;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startAfter!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'DLQ: fila de onde o job veio' })
  sourceQueue!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'DLQ: id do job original' })
  sourceJobId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  errorName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Mensagem do erro (truncada). O payload do job nunca é exposto.',
  })
  errorMessage!: string | null;
}
