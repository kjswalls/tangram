// The workspace root lints `scripts/**`; `apps/app` lints itself with its own
// flat config. Plain typescript-eslint rather than `eslint-config-next`: these
// are Node scripts, not React, and W1 removes the Next preset from the app's
// config too.
//
// This config exists because W0 left `scripts/` at the workspace root
// (docs/plans/wave-zero.md §1) while `tsconfig.json` and `eslint.config.mjs`
// moved into `apps/app/`. Without it those four files would be linted by
// nothing, which is a silent loss rather than a decision.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'apps/**',
      'packages/**',
      'node_modules/**',
      'data/**',
      '.cache/**',
      '**/.next/**',
      '**/dist/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' },
    },
  },
  {
    // The service worker template. It was linted before the workspace move,
    // when it sat inside the app's eslint scope, and a syntax-broken worker
    // otherwise passes lint, typecheck (allowJs is false), the tests that read
    // it as text, and the build that copies it — and then fails to install in
    // a browser. It runs in a ServiceWorkerGlobalScope, hence the globals.
    files: ['scripts/sw.template.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        skipWaiting: 'readonly',
      },
    },
  },
];
