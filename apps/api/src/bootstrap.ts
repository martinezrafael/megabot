import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import { AppModule, type AppModuleOptions } from './app.module';
import type { Auth } from './auth/auth';
import { AUTH } from './auth/auth.tokens';

/**
 * Monta a aplicação. Usado pelo main.ts e pelos testes.
 */
export async function createApp(options: AppModuleOptions): Promise<NestExpressApplication> {
  // bodyParser: false -> o Better Auth precisa ler o corpo da requisição "cru".
  // Reativamos o parser JSON logo abaixo, DEPOIS de registrar as rotas de auth.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    bodyParser: false,
    logger: process.env.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
  });

  // CORS: só o nosso front-end, com cookies (credentials).
  app.enableCors({ origin: options.config.webUrl, credentials: true });

  // Rotas de autenticação (/api/auth/*) são atendidas direto pelo Better Auth.
  const auth = app.get<Auth>(AUTH);
  app.getHttpAdapter().getInstance().all('/api/auth/*splat', toNodeHandler(auth));

  // Para as demais rotas, o JSON volta a ser interpretado normalmente.
  app.useBodyParser('json');

  return app;
}
