import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// Reaproveita o .env da raiz do monorepo (mesmo padrão do prisma.config.ts).
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Falha rápida: valida as variáveis antes de qualquer coisa subir.
// (import dinâmico/require: o next.config roda antes do bundler do Next)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseWebEnv } = require('./src/env') as typeof import('./src/env');
parseWebEnv(process.env);

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
