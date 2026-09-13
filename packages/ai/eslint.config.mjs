// The workspace root's config ignores `packages/**`, so a package without its
// own is linted by nothing — the silent loss web.md W0's review found for
// scripts/sw.template.js.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
