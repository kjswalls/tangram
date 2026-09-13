import { describe, expect, it } from 'vitest';

import { DEMO_PARAGRAPH } from '@/lib/dev/seed';

import { DEMO_PARAGRAPH as E2E_PARAGRAPH, JIXU_SENTENCE } from '../../e2e/p5/paragraph';

/**
 * The e2e specs read the demo paragraph but cannot import it: Playwright
 * transpiles a spec without the app's runtime graph, and `lib/dev/seed.ts`
 * pulls in Dexie. So the string is copied into `tests/e2e/p5/helpers.ts` and
 * pinned here — if the seed's paragraph changes, this fails rather than the
 * reader specs quietly testing yesterday's text.
 */
describe('the reader specs read the seed’s paragraph', () => {
  it('is the same string', () => {
    expect(E2E_PARAGRAPH).toBe(DEMO_PARAGRAPH);
  });

  it('contains the sentence the mining spec expects', () => {
    expect(DEMO_PARAGRAPH).toContain(JIXU_SENTENCE.slice(0, -1));
    expect(JIXU_SENTENCE).toContain('继续');
  });
});
