import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await createApp({ config });
  await app.listen(config.port);
  console.info(`API rodando em ${config.authUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
