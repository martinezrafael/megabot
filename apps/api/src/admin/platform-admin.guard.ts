import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth.context';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Restringe a rota a administradores da plataforma. Roda DEPOIS do AuthGuard global
 * (que já garantiu a sessão); aqui só decidimos se essa pessoa pode ver o painel.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(@Inject(PlatformAdminService) private readonly admins: PlatformAdminService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!this.admins.isPlatformAdmin(request.auth)) {
      throw new ForbiddenException('Acesso restrito a administradores da plataforma');
    }
    return true;
  }
}
