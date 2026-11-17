import { Module } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformAdminService } from './platform-admin.service';

/** Regra "quem é administrador da plataforma", compartilhada pelo /me e pelas rotas de /admin. */
@Module({
  providers: [PlatformAdminService, PlatformAdminGuard],
  exports: [PlatformAdminService, PlatformAdminGuard],
})
export class PlatformAdminModule {}
