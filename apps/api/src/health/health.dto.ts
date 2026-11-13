import { ApiProperty } from '@nestjs/swagger';

export class LivenessResponseDto {
  @ApiProperty({ type: String, example: 'ok' })
  status!: string;
}

export class ReadinessResponseDto {
  @ApiProperty({ type: String, enum: ['ok', 'error', 'shutting_down'], example: 'ok' })
  status!: string;

  @ApiProperty({
    type: Object,
    example: { database: { status: 'up' } },
    description: 'Dependências saudáveis',
  })
  info!: Record<string, unknown>;

  @ApiProperty({ type: Object, example: {}, description: 'Dependências com problema' })
  error!: Record<string, unknown>;

  @ApiProperty({
    type: Object,
    example: { database: { status: 'up' } },
    description: 'Detalhe de todas as dependências',
  })
  details!: Record<string, unknown>;
}
