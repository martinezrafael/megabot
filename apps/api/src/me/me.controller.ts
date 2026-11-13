import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type AuthContext, CurrentAuth } from '../auth/auth.context';
import { ErrorResponseDto } from '../common/error-response.dto';
import { MeResponseDto } from './me.dto';

@ApiTags('me')
@ApiCookieAuth('session')
@Controller()
export class MeController {
  /** Devolve quem está logado e a qual empresa (tenant) pertence. */
  @Get('me')
  @ApiOperation({ summary: 'Usuário logado e seu tenant' })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Sem sessão válida' })
  @ApiResponse({
    status: 429,
    type: ErrorResponseDto,
    description: 'Limite de requisições excedido',
  })
  me(@CurrentAuth() auth: AuthContext): MeResponseDto {
    return {
      user: { ...auth.user, image: auth.user.image ?? null },
      tenant: auth.tenantId && auth.role ? { id: auth.tenantId, role: auth.role } : null,
    };
  }
}
