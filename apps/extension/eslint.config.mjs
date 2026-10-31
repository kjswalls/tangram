// The workspace root's config ignores `apps/**`, so the extension carries its own,
// shaped like packages/ai's.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Chinese string literals and comments are full of ideographic spaces and
    // full-width punctuation on purpose.
    rules: {
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true },
      ],
    },
  },
];
