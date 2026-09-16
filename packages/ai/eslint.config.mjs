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
    //
    // **What did change, stated rather than discovered later.** Comparing
    // `eslint --print-config` for the same file before and after the move, this
    // config applies 66 rules where the app's applied 68. The two it drops are
    // `react-hooks/rules-of-hooks` and `react-hooks/exhaustive-deps`, which the
    // app deliberately points at `.ts` as well as `.tsx`. They are NOT
    // reinstated: this package is compiled by `apps/server` and must never
    // contain React, so the right guard is the absence of the dependency rather
    // than a lint rule for code that may not exist here. `languageOptions.globals`
    // also goes from the app's browser+node set to none, which is inert only
    // because typescript-eslint's recommended set turns `no-undef` off for TS.
    rules: {
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true },
      ],
    },
  },
];
