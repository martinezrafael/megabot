import { Controller, Get } from '@nestjs/common';
import { type AuthContext, CurrentAuth } from './auth/auth.context';

@Controller()
export class MeController {
  /** Devolve quem está logado e a qual empresa (tenant) pertence. */
  @Get('me')
  me(@CurrentAuth() auth: AuthContext) {
    return {
      user: auth.user,
      tenant: auth.tenantId ? { id: auth.tenantId, role: auth.role } : null,
    };
  }
}
