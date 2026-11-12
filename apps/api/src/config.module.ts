import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from './config';
import { APP_CONFIG } from './config.tokens';

/** Disponibiliza a configuração validada para qualquer módulo (`@Inject(APP_CONFIG)`). */
@Global()
@Module({})
export class AppConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
