import { Logger } from 'nestjs-pino';
import { createApp } from './bootstrap';
import { ConfigError, loadConfig } from './config';

async function main() {
  // Falha rápida: se a configuração estiver errada, o processo termina aqui.
  const config = loadConfig();

  const app = await createApp({ config });
  app.enableShutdownHooks();
  await app.listen(config.port);

  app
    .get(Logger)
    .log(
      `API rodando em ${config.authUrl} (docs: ${config.swaggerEnabled ? `${config.authUrl}/docs` : 'desativada'})`,
    );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
