import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../config.tokens';
import type { AuthContext } from '../auth/auth.context';

/**
 * "Administrador da plataforma" = equipe do Megabot, definida pela variável PLATFORM_ADMIN_EMAILS.
 * É diferente do papel ADMIN/OWNER de uma empresa (tenant): este enxerga dados de TODAS as empresas
 * (ex.: a fila de jobs), então não pode ser algo que um cliente consiga ter.
 */
@Injectable()
export class PlatformAdminService {
  private readonly emails: ReadonlySet<string>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.emails = new Set(config.platformAdminEmails);
  }

  isPlatformAdmin(auth: Pick<AuthContext, 'user'> | undefined): boolean {
    if (!auth) return false;
    // E-mail precisa estar verificado: ninguém vira admin só por cadastrar o e-mail de outra pessoa.
    return auth.user.emailVerified && this.emails.has(auth.user.email.toLowerCase());
  }
}
