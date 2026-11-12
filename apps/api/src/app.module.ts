import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import type { AppConfig } from './config';
import { AppConfigModule } from './config.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import type { DbPing } from './health/database.health';
import { HealthModule } from './health/health.module';
import { createLoggerModule } from './logging/logger.module';
import type { Mailer } from './mailer';
import { MeModule } from './me/me.module';
import { createThrottlerOptions } from './rate-limit';
import type { DestinationStream } from 'pino';

export interface AppModuleOptions {
  config: AppConfig;
  /** Troca o envio de e-mail (testes). */
  mailer?: Mailer;
  /** Captura as linhas de log (testes). */
  logStream?: DestinationStream;
  /** Troca o ping do banco usado no readiness (testes). */
  dbPing?: DbPing;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const { config } = options;

    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        createLoggerModule(config, options.logStream),
        ThrottlerModule.forRoot(createThrottlerOptions(config)),
        AuthModule.register(options),
        HealthModule.register({ ping: options.dbPing }),
        MeModule,
      ],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // A ORDEM IMPORTA: o limite roda antes da checagem de sessão, para que
        // uma enxurrada de requisições anônimas nem chegue a consultar o banco.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
