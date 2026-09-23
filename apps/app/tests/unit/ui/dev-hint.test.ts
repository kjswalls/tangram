/**
 * The operator's half of the three "offline" disclosures is development-only
 * (first-run audit, HANDOFF.md 2026-09-23). A production build told the learner
 * to "set ANTHROPIC_API_KEY".
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withDevHint } from '@/lib/dev-hint';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('withDevHint', () => {
  it('keeps the learner half and drops the hint outside development', () => {
    expect(withDevHint('Offline grader', ' — set X', false)).toBe('Offline grader');
    expect(withDevHint('Offline grader', ' — set X', true)).toBe('Offline grader — set X');
  });

  it('no component names an environment variable outside a dev hint', () => {
    // Every literal mention of the key in shipped components must be the
    // second argument of `withDevHint`, which a production build drops.
    for (const file of [
      'components/lookup/ask-panel.tsx',
      'components/review/example-sentences.tsx',
      'components/review/recall-input.tsx',
    ]) {
      const source = readFileSync(join(appRoot, file), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
      const strings = source.match(/'[^'\n]*ANTHROPIC_API_KEY[^'\n]*'/g) ?? [];
      expect(strings.length, file).toBeGreaterThan(0);
      for (const literal of strings) {
        const at = source.indexOf(literal);
        expect(source.slice(Math.max(0, at - 80), at), `${file}: ${literal}`).toMatch(/withDevHint\([^)]*,\s*$/);
      }
    }
  });
});
