import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config';
import { createSmtpMailer, type Mailer } from '../mailer';
import { createAuth } from './auth';
import { APP_CONFIG, AUTH, MAILER } from './auth.tokens';

export interface AuthModuleOptions {
  config: AppConfig;
  /** Permite trocar o mailer (testes). Por padrão usa SMTP. */
  mailer?: Mailer;
}

@Global()
@Module({})
export class AuthModule {
  static register({ config, mailer }: AuthModuleOptions): DynamicModule {
    const resolvedMailer = mailer ?? createSmtpMailer(config.smtp);

    return {
      module: AuthModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: MAILER, useValue: resolvedMailer },
        { provide: AUTH, useValue: createAuth({ config, mailer: resolvedMailer }) },
      ],
      exports: [APP_CONFIG, MAILER, AUTH],
    };
  }
}
