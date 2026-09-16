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
        // The precache list, substituted by `scripts/build-sw.ts` (W3). The
        // build id's placeholder sits inside a string literal and needs no
        // declaration; this one is a bare expression, because the substituted
        // value is a JSON array and wrapping it in a string would mean a
        // `JSON.parse` at worker startup whose failure mode is a worker that
        // installs and caches nothing. Declared here so the template still
        // lints as the real worker it becomes — which is the whole reason W0
        // put this block back.
        __TANGRAM_PRECACHE__: 'readonly',
      },
    },
  },
];
