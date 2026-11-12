import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../auth/public.decorator';
import { ErrorResponseDto } from '../common/error-response.dto';
import { DatabaseHealthIndicator } from './database.health';
import { LivenessResponseDto, ReadinessResponseDto } from './health.dto';

/**
 * Rotas públicas e sem rate limit: são chamadas por orquestradores/monitoramento.
 * - /health        -> liveness: "o processo está de pé?" (não consulta nada externo)
 * - /health/ready  -> readiness: "consigo atender?" (confere o banco)
 */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(DatabaseHealthIndicator) private readonly database: DatabaseHealthIndicator,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness: o processo está no ar' })
  @ApiOkResponse({ type: LivenessResponseDto })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  // swaggerDocumentation:false -> documentamos nós mesmos (o 503 passa pelo nosso filtro de erros).
  @HealthCheck({ noCache: true, swaggerDocumentation: false })
  @ApiOperation({ summary: 'Readiness: as dependências (banco) estão respondendo' })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: 'Alguma dependência está fora do ar',
  })
  ready() {
    return this.health.check([() => this.database.isHealthy('database')]);
  }
}
