import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { listUserTenants } from '@megabot/database';
import type { Auth } from './auth';
import { AUTH } from './auth.tokens';
import type { AuthedRequest } from './auth.context';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard global: toda rota exige sessão, exceto as marcadas com @Public().
 * Registrado como APP_GUARD no AppModule.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();

    // Lê o cookie de sessão, valida no banco e devolve usuário + sessão (ou null).
    const result = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!result) throw new UnauthorizedException('Sessão ausente ou expirada');

    // Descobre o tenant do usuário (ver migration membership_self_select_policy).
    const [active] = await listUserTenants(result.user.id);

    request.auth = {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        image: result.user.image,
        emailVerified: result.user.emailVerified,
      },
      session: { id: result.session.id, expiresAt: result.session.expiresAt },
      tenantId: active?.tenantId ?? null,
      role: active?.role ?? null,
    };
    return true;
  }
}
