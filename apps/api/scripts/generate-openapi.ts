/**
 * Gera apps/api/openapi.json (o contrato da API).
 * Uso: pnpm --filter @megabot/api openapi:generate   (ou: pnpm openapi:generate na raiz)
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateOpenApiSpec } from '../src/openapi-spec';

const OUTPUT = path.resolve(__dirname, '../openapi.json');

async function main() {
  const spec = await generateOpenApiSpec();
  await writeFile(OUTPUT, `${JSON.stringify(spec, null, 2)}\n`);
  console.info(`OpenAPI gerado em ${OUTPUT} (${Object.keys(spec.paths).length} caminhos)`);
  // O pool do Prisma mantém conexões abertas; encerramos explicitamente.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
