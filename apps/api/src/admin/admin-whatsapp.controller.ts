import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from '../auth/auth.context';
import { ErrorResponseDto } from '../common/error-response.dto';
import {
  ConnectWhatsappNumberBodyDto,
  ConnectWhatsappNumberResponseDto,
  WhatsappConnectionDto,
} from './admin-whatsapp.dto';
import { AdminWhatsappService } from './admin-whatsapp.service';
import { PlatformAdminGuard } from './platform-admin.guard';

const connectBody = z.strictObject({
  tenantId: z.uuid(),
  phoneNumberId: z.string().regex(/^\d{1,32}$/, 'use só dígitos (até 32)'),
  wabaId: z
    .string()
    .trim()
    .regex(/^[\w-]{1,64}$/, 'id inválido'),
  accessToken: z.string().min(20, 'token curto demais').max(2048, 'token longo demais'),
  displayPhoneNumber: z.string().trim().min(1).max(32).optional(),
});

const listQuery = z.object({ tenantId: z.uuid() });

function parseOrBadRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Só caminho + mensagem do Zod (nunca o valor recebido: o corpo tem o token).
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

/**
 * Conexão manual de número do WhatsApp (T1.7). Só administradores da plataforma.
 * O token de acesso é cifrado (envelope) antes de ir ao banco e NUNCA volta em nenhuma resposta.
 */
@ApiTags('admin')
@ApiCookieAuth('session')
@UseGuards(PlatformAdminGuard)
@Controller('admin/whatsapp/connections')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Sem sessão válida' })
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: 'Não é administrador da plataforma',
})
export class AdminWhatsappController {
  constructor(@Inject(AdminWhatsappService) private readonly service: AdminWhatsappService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Conectar (ou atualizar) o número do WhatsApp de uma empresa, guardando o token cifrado',
  })
  @ApiBody({ type: ConnectWhatsappNumberBodyDto })
  @ApiCreatedResponse({
    type: ConnectWhatsappNumberResponseDto,
    description: '`created=true` (nova) ou `created=false` (atualizada; o status HTTP é 200)',
  })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Corpo inválido' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Empresa inexistente' })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'O número já está conectado a OUTRA empresa',
  })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: 'Criptografia de tokens não configurada no servidor',
  })
  async connect(
    @Body() body: unknown,
    @Req() request: AuthedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectWhatsappNumberResponseDto> {
    const input = parseOrBadRequest(connectBody, body);
    const result = await this.service.connect(input, request.auth?.user.email ?? 'desconhecido');
    if (!result.created) response.status(200);
    return {
      created: result.created,
      connection: {
        ...result.connection,
        tokenUpdatedAt: result.connection.tokenUpdatedAt?.toISOString() ?? null,
        createdAt: result.connection.createdAt.toISOString(),
        updatedAt: result.connection.updatedAt.toISOString(),
      },
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Conexões de uma empresa (sem o token)' })
  @ApiQuery({ name: 'tenantId', required: true, type: String })
  @ApiOkResponse({ type: [WhatsappConnectionDto] })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'tenantId inválido' })
  async list(@Query() query: Record<string, unknown>): Promise<WhatsappConnectionDto[]> {
    const { tenantId } = parseOrBadRequest(listQuery, query);
    const rows = await this.service.list(tenantId);
    return rows.map((c) => ({
      ...c,
      tokenUpdatedAt: c.tokenUpdatedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }
}
