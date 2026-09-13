// Flat config. eslint-config-next 16 ships flat presets directly, so no FlatCompat.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'data/**',
      'playwright-report/**',
      'test-results/**',
      '.cache/**',
      'next-env.d.ts',
    ],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
