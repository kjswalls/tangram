/**
 * The export W8 said to confirm rather than assume (docs/plans/web.md W8).
 *
 * "React Router provides a scroll-restoration component — confirm it is
 * exported by the installed 8.x rather than assuming the v6 spelling." This is
 * that confirmation, run rather than read, and it is the case that fails on the
 * day a major moves or renames it instead of the app silently losing scroll
 * restoration with every test still green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as router from 'react-router';

import { AppScrollRestoration } from '@/src/shell/scroll-restoration';

describe('scroll restoration', () => {
  it('is the component react-router 8 actually exports', () => {
    expect(router.ScrollRestoration).toBeTypeOf('function');
    expect(AppScrollRestoration).toBe(router.ScrollRestoration);
  });

  it('is mounted by the root route, once', () => {
    // A second one would restore twice and fight itself; none at all is the
    // regression this file exists to catch, and it is invisible in jsdom.
    const root = join(import.meta.dirname, '..', '..', '..', 'src', 'root.tsx');
    // Comments stripped: the file's own header names the component twice
    // while explaining it, and a count that includes prose counts prose.
    const source = readFileSync(root, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source.match(/<AppScrollRestoration \/>/g)).toHaveLength(1);
  });
});
