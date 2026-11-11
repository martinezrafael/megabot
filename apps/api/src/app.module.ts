import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from './config';
import type { Mailer } from './mailer';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';
import { MeController } from './me.controller';

export interface AppModuleOptions {
  config: AppConfig;
  mailer?: Mailer;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [AuthModule.register(options)],
      controllers: [HealthController, MeController],
      // Guard global: protege TODAS as rotas por padrão.
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
