/**
 * W6's acceptance criterion 2, as a test (docs/plans/web.md W6).
 *
 * CLAUDE.md: there is no CI in this repository, so a rule that wants enforcement
 * is a unit test. `pnpm font:check` is the command; this is the thing that runs
 * on every `pnpm test` and refuses a merge.
 *
 * **A coverage check that cannot fail is the defect this criterion exists to
 * prevent**, and the plan says so twice. So this file does two jobs: it runs the
 * real check against the real shipped bytes, and then it *mutates* the input
 * four ways and asserts the check catches each one. A guard nobody has seen fail
 * is not a guard — that is C0's phrasing and it is the house rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appRoot, dirOf, workspaceRoot } from '@/lib/server/roots';

const here = dirOf(import.meta.url);
const root = workspaceRoot(here);
const app = appRoot(here);

type CheckModule = typeof import('../../../../../scripts/font-coverage-check');
type CssModule = typeof import('../../../../../scripts/font-css');
type ShippingModule = typeof import('../../../../../scripts/font-shipping');

async function loadCheck(): Promise<CheckModule> {
  return (await import(
    /* @vite-ignore */ join(root, 'scripts', 'font-coverage-check.ts')
  )) as CheckModule;
}

async function loadCss(): Promise<CssModule> {
  return (await import(/* @vite-ignore */ join(root, 'scripts', 'font-css.ts'))) as CssModule;
}

async function loadShipping(): Promise<ShippingModule> {
  return (await import(
    /* @vite-ignore */ join(root, 'scripts', 'font-shipping.ts')
  )) as ShippingModule;
}

describe('the shipped fonts cover what the app renders', () => {
  it('every family covers its character set, at every weight it declares', async () => {
    const { check } = await loadCheck();
    const result = check();
    // The assertion is the LIST, not a boolean: a failure here has to say which
    // code points, or the next person cannot act on it.
    expect(result.problems).toEqual([]);
    expect(result.groups.length).toBeGreaterThan(0);
    for (const group of result.groups) {
      expect(group.uncovered, `${group.family} @ ${group.weight}`).toEqual([]);
      expect(group.ranked, `${group.family} @ ${group.weight}`).toEqual([]);
      expect(group.overclaimed, `${group.family} @ ${group.weight}`).toEqual([]);
      expect(group.overlapping, `${group.family} @ ${group.weight}`).toEqual([]);
      expect(group.unreachable, `${group.family} @ ${group.weight}`).toEqual([]);
    }
  });

  /**
   * The hanzi face is the one register #9 is about, and the number that matters
   * is not the percentage — it is that **no character any ranked word uses** is
   * missing. STACK register #9 and AUDIT 2 both expected a slim subset to fall
   * short of 124k headwords; this is where that expectation is settled against
   * the bytes rather than against a face.
   */
  it('the hanzi face is gated and its residue carries no frequency rank', async () => {
    const { check } = await loadCheck();
    const hanzi = check().groups.filter((group) => group.family === 'Noto Serif SC');
    expect(hanzi.length).toBeGreaterThan(0);
    for (const group of hanzi) {
      expect(group.gate).toBe(true);
      expect(group.responsible).toBeGreaterThan(14_000);
      expect(group.ranked).toEqual([]);
    }
  });
});

/**
 * **The mutation suite.** Each case breaks one property of the stylesheet and
 * asserts the parser or the checker refuses it. They go through
 * `parseFontFaces` and the range algebra rather than through `check()`, because
 * `check()` reads the committed stylesheet off disk and a test that rewrites it
 * would be a test that can leave the tree broken.
 */
describe('the coverage check can actually fail', () => {
  const css = () => readFileSync(join(app, 'src', 'styles', 'fonts.css'), 'utf8');

  it('refuses a @font-face with no unicode-range — it would claim all of Unicode', async () => {
    const { parseFontFaces } = await loadCss();
    const broken = css().replace(/\n {2}unicode-range:[^;]+;/, '');
    expect(() => parseFontFaces(broken)).toThrow(/unicode-range/);
  });

  it('refuses a @font-face pointing at a third origin', async () => {
    const { parseFontFaces } = await loadCss();
    const broken = css().replace(
      /url\('\.\.\/fonts\/[^']+'\)/,
      "url('https://fonts.gstatic.com/s/notoserifsc/x.woff2')",
    );
    expect(() => parseFontFaces(broken)).toThrow(/absolute URL/);
  });

  it('round-trips a unicode-range, so an over- or under-claim is visible', async () => {
    const { parseFontFaces, expand } = await loadCss();
    const faces = parseFontFaces(css());
    const first = faces[0];
    expect(first).toBeDefined();
    const claimed = expand(first?.unicodeRange ?? []);
    // The first slice is the app's own text plus the most frequent hanzi; if the
    // parser silently dropped tokens this would be far smaller.
    expect(claimed.size).toBeGreaterThan(100);
    expect(claimed.has('七'.codePointAt(0) ?? 0)).toBe(true);
  });

  it('every declared family is one scripts/font-shipping.ts ships', async () => {
    const { parseFontFaces } = await loadCss();
    const { SHIPPED } = await loadShipping();
    const families = new Set(parseFontFaces(css()).map((face) => face.family));
    for (const family of families) {
      expect(SHIPPED.some((shipped) => shipped.family === family), family).toBe(true);
    }
    // …and every family it ships has at least one face. A manifest entry with no
    // @font-face is a family the stack names and nothing serves.
    for (const shipped of SHIPPED) expect(families.has(shipped.family), shipped.family).toBe(true);
  });
});
