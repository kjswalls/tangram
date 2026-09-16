// The workspace root's config ignores `packages/**`, so a package without its
// own is linted by nothing — the silent loss web.md W0's review found for
// scripts/sw.template.js.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Carried over from `apps/app/eslint.config.mjs` with the eleven modules
    // wave-zero.md §5 moved here: `no-irregular-whitespace` fires on the
    // ideographic spaces and full-width punctuation inside Chinese string
    // literals, which `fake.ts`'s canned answers and `ground.ts`'s comments are
    // full of on purpose. Off in strings and comments, on everywhere it means a
    // typo — the same shape the app uses, so a module does not change how it is
    // linted by changing which directory it sits in.
    rules: {
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true },
      ],
    },
  },
];
