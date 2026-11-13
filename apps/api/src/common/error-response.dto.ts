import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Formato padrão de TODOS os erros da API. */
export class ErrorResponseDto {
  @ApiProperty({ type: Number, example: 401 })
  statusCode!: number;

  @ApiProperty({ type: String, example: 'Unauthorized', description: 'Nome do status HTTP' })
  error!: string;

  @ApiProperty({ type: String, example: 'Sessão ausente ou expirada' })
  message!: string;

  @ApiProperty({
    type: String,
    example: '0b6d0f3e-5c3b-4d5a-9a52-3f3b6c7d9a10',
    description: 'Identificador da requisição (mesmo valor do cabeçalho x-request-id e dos logs)',
  })
  requestId!: string;

  @ApiProperty({ type: String, example: '/me' })
  path!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  timestamp!: string;

  @ApiPropertyOptional({
    type: Object,
    description: 'Informações extras (ex.: resultado do readiness check)',
  })
  details?: Record<string, unknown>;
}
