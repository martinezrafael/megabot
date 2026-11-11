import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// Reaproveita o .env da raiz do monorepo (mesmo padrão do prisma.config.ts).
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
