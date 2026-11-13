import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type NextFunction, type Request, type Response } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppModuleOptions } from './app.module';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './logging/request-id';
import { setupSwagger } from './openapi';

const parseJson = json({ limit: '100kb' });

/**
 * Lê o corpo JSON de todas as rotas, MENOS as de /api/auth: o Better Auth
 * precisa receber o corpo ainda "cru" (um stream que ainda não foi lido).
 */
function jsonUnlessAuth(req: Request, res: Response, next: NextFunction) {
  if (req.path.startsWith('/api/auth')) return next();
  return parseJson(req, res, next);
}

/**
 * Monta a aplicação. Usado pelo main.ts, pelo gerador de OpenAPI e pelos testes.
 */
export async function createApp(options: AppModuleOptions): Promise<NestExpressApplication> {
  const { config } = options;

  // bodyParser: false -> registramos o nosso parser logo abaixo (ver jsonUnlessAuth).
  // bufferLogs: guarda os logs de inicialização até o pino estar pronto.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  // Atrás de proxy/load balancer, é o que faz o rate limit enxergar o IP real.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Request id o mais cedo possível: até erros de body-parser saem com ele.
  app.use(requestIdMiddleware);

  // CORS: só o nosso front-end, com cookies (credentials).
  app.enableCors({
    origin: config.webUrl,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER, 'retry-after'],
  });

  app.use(jsonUnlessAuth);

  if (config.swaggerEnabled) await setupSwagger(app, config);

  return app;
}
