// The server's flat config. Plain typescript-eslint: this is Node, not React,
// and the workspace root's config ignores `apps/**` so a package that does not
// bring its own is linted by nothing — the silent loss `web.md` W0's review
// found for `scripts/sw.template.js`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        WeakSet: 'readonly',
      },
    },
  },
];
