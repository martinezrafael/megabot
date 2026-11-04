import { baseConfig } from './base.mjs';

export const nodeConfig = [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
];
