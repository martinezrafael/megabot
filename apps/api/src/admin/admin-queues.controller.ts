import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JOB_STATES } from '@megabot/queue';
import { z } from 'zod';
import { ErrorResponseDto } from '../common/error-response.dto';
import { JobSummaryDto, QueuesSnapshotDto } from './admin-queues.dto';
import { AdminQueuesService } from './admin-queues.service';
import { PlatformAdminGuard } from './platform-admin.guard';

const queueName = z.string().regex(/^[\w.-]{1,100}$/, 'nome de fila inválido');

const jobsQuery = z.object({
  state: z.enum(JOB_STATES).optional(),
  tenantId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function parseOrBadRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

/**
 * Tela de filas do admin (T1.3). Somente leitura: lê as tabelas do pg-boss e mostra o estado das
 * filas e dos jobs de TODAS as empresas, por isso só administradores da plataforma entram.
 */
@ApiTags('admin')
@ApiCookieAuth('session')
@UseGuards(PlatformAdminGuard)
@Controller('admin/queues')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Sem sessão válida' })
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: 'Não é administrador da plataforma',
})
export class AdminQueuesController {
  constructor(@Inject(AdminQueuesService) private readonly queues: AdminQueuesService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Resumo de todas as filas (e DLQs) com a contagem de jobs por estado' })
  @ApiOkResponse({ type: QueuesSnapshotDto })
  overview(): Promise<QueuesSnapshotDto> {
    return this.queues.overview();
  }

  @Get(':name/jobs')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Jobs mais recentes de uma fila (sem o payload)' })
  @ApiParam({ name: 'name', type: String, example: 'whatsapp.inbound.dlq' })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: JOB_STATES,
  })
  @ApiQuery({ name: 'tenantId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '1 a 100 (padrão 25)' })
  @ApiOkResponse({ type: [JobSummaryDto] })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Filtro inválido' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Fila inexistente' })
  jobs(@Param('name') name: string, @Query() query: Record<string, unknown>) {
    const filters = parseOrBadRequest(jobsQuery, query);
    return this.queues.jobs({ queue: parseOrBadRequest(queueName, name), ...filters });
  }
}
