import { baseConfig } from '@megabot/eslint-config';

// schema.d.ts é gerado a partir do contrato OpenAPI: não editamos nem lintamos.
export default [...baseConfig, { ignores: ['.next/**', 'next-env.d.ts', 'src/lib/api/schema.d.ts'] }];
