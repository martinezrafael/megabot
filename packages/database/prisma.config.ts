import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const envPath = path.resolve(__dirname, '../../.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://megabot_app:megabot_pass@localhost:5432/megabot?schema=public',
  },
});
