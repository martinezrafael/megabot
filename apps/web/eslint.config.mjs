import { baseConfig } from '@megabot/eslint-config';

export default [...baseConfig, { ignores: ['.next/**', 'next-env.d.ts'] }];
