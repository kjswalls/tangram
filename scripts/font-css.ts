/**
 * `unicode-range` — writing it, and reading it back (docs/plans/web.md W6).
 *
 * The generator and the checker must agree exactly about what a range means, so
 * they share one formatter and one parser. `scripts/font-subset.ts` writes
 * `apps/app/src/styles/fonts.css`; `scripts/font-coverage-check.ts` parses that
 * same file and asserts that what each `@font-face` *claims* is what the file
 * behind it actually *has*.
 *
 * **Why the claim has to be exact, rather than merely generous.** CSS font
 * matching picks, for a given code point, the first `@font-face` in the family
 * whose `unicode-range` contains it — and if that file turns out to have no
 * glyph, the engine falls through to the **next family in the stack**, not to
 * the next `@font-face`. So a range that over-claims silently sends the browser
 * to a file that cannot answer, and a range that under-claims leaves a code
 * point to the fallback stack even though the glyph was shipped. Overlaps and
 * gaps are therefore both defects, and `font-coverage-check.ts` refuses both.
 */

/** A closed, inclusive code point interval. */
export interface CodeRange {
  from: number;
  to: number;
}

/** Sorted, coalesced intervals over a set of code points. */
export function toRanges(codePoints: Iterable<number>): CodeRange[] {
  const sorted = [...new Set(codePoints)].sort((a, b) => a - b);
  const ranges: CodeRange[] = [];
  for (const cp of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && cp === last.to + 1) last.to = cp;
    else ranges.push({ from: cp, to: cp });
  }
  return ranges;
}

function hex(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

/** `U+4E00-4E05,U+4E07` — the `unicode-range` descriptor's value. */
export function formatUnicodeRange(ranges: readonly CodeRange[]): string {
  return ranges
    .map((range) => (range.from === range.to ? `U+${hex(range.from)}` : `U+${hex(range.from)}-${hex(range.to)}`))
    .join(',');
}

/**
 * Parse a `unicode-range` value back into intervals.
 *
 * Handles the two forms this repo emits (`U+XXXX` and `U+XXXX-YYYY`) and the
 * wildcard form (`U+4??`) that it does not, so that a hand-edited stylesheet is
 * read correctly rather than silently dropped.
 */
export function parseUnicodeRange(value: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  for (const raw of value.split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    const body = /^[uU]\+(.+)$/.exec(token)?.[1];
    if (body === undefined) throw new Error(`unparsable unicode-range token: ${token}`);
    if (body.includes('?')) {
      const from = Number.parseInt(body.replaceAll('?', '0'), 16);
      const to = Number.parseInt(body.replaceAll('?', 'F'), 16);
      ranges.push({ from, to });
      continue;
    }
    const [start, end] = body.split('-');
    const from = Number.parseInt(start ?? '', 16);
    if (!Number.isFinite(from)) throw new Error(`unparsable unicode-range token: ${token}`);
    ranges.push({ from, to: end === undefined ? from : Number.parseInt(end, 16) });
  }
  return ranges;
}

export function expand(ranges: readonly CodeRange[]): Set<number> {
  const out = new Set<number>();
  for (const range of ranges) for (let cp = range.from; cp <= range.to; cp += 1) out.add(cp);
  return out;
}

export interface ParsedFace {
  family: string;
  weight: string;
  style: string;
  display: string;
  /** The `url()` as written, relative to the stylesheet. */
  src: string;
  unicodeRange: CodeRange[];
  /** 1-based, for an error message that points at a line. */
  index: number;
}

const DESCRIPTOR = /([a-z-]+)\s*:\s*([^;]+);/g;

/**
 * A deliberately small `@font-face` reader.
 *
 * It parses the file this repo generates, and it **throws** on anything it does
 * not recognise rather than skipping it — a checker that silently ignores a
 * `@font-face` it cannot parse is a checker that passes when the stylesheet is
 * broken, which is the whole class of defect W6's coverage criterion exists to
 * prevent.
 */
export function parseFontFaces(css: string): ParsedFace[] {
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const faces: ParsedFace[] = [];
  const blocks = withoutComments.matchAll(/@font-face\s*\{([^}]*)\}/g);
  let index = 0;
  for (const block of blocks) {
    index += 1;
    const body = block[1] ?? '';
    const values = new Map<string, string>();
    for (const [, name, value] of body.matchAll(DESCRIPTOR)) {
      values.set((name ?? '').trim(), (value ?? '').trim());
    }
    const family = values.get('font-family');
    const src = values.get('src');
    const range = values.get('unicode-range');
    if (family === undefined) throw new Error(`@font-face #${index} has no font-family`);
    if (src === undefined) throw new Error(`@font-face #${index} (${family}) has no src`);
    if (range === undefined) {
      throw new Error(
        `@font-face #${index} (${family}) has no unicode-range. Every face this repo ships ` +
          `declares one; a face without one claims the whole of Unicode and will be downloaded ` +
          `for any text at all.`,
      );
    }
    const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(src)?.[1];
    if (url === undefined) throw new Error(`@font-face #${index} (${family}) has no url() in src`);
    if (/^(https?:)?\/\//.test(url)) {
      throw new Error(
        `@font-face #${index} (${family}) points at an absolute URL (${url}). W6 self-hosts: a ` +
          `third origin is unreachable from Capacitor's local scheme and is never storable by the ` +
          `service worker, whose test is response.type === 'basic'.`,
      );
    }
    faces.push({
      family: family.replaceAll(/^['"]|['"]$/g, ''),
      weight: values.get('font-weight') ?? 'normal',
      style: values.get('font-style') ?? 'normal',
      display: values.get('font-display') ?? 'auto',
      src: url,
      unicodeRange: parseUnicodeRange(range),
      index,
    });
  }
  return faces;
}
