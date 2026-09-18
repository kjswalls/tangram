/**
 * `pnpm font:subset` — cut the shipped webfonts and write the stylesheet that
 * names them (docs/plans/web.md W6).
 *
 * Input: the vendored binaries `pnpm font:fetch` pins by sha256, plus the two
 * character sets in `scripts/font-charset.ts`.
 * Output: `apps/app/src/fonts/*.woff2` (generated, gitignored) and
 * `apps/app/src/styles/fonts.css` (generated, **committed**).
 *
 * **Why the stylesheet is committed and the binaries are not.** The binaries
 * are megabytes and reproducible from pinned inputs, exactly like `data/*.json`
 * — so they follow `data/`'s rule. The stylesheet is text, and it is the
 * manifest of what ships: every slice, its weight range and its exact
 * `unicode-range`, in a diff a reviewer can read. Ignoring it would hide the one
 * artifact of this phase that a human should look at, and would leave a fresh
 * clone unable to typecheck the app because `src/main.tsx` imports it.
 *
 * `--ensure` is `data:ensure`'s contract: do nothing if every output is already
 * on disk. `pnpm build` runs it, so a fresh clone builds without a second
 * command, and it vendors the binaries first if they are missing.
 *
 * ---
 *
 * The head/tail slice split and the arithmetic behind it are in
 * `scripts/font-shipping.ts`; the short version is that the frequent characters
 * are cut by frequency (so a first paint pulls one small file) and everything
 * else by code point (so declaring it costs kilobytes of CSS rather than a
 * hundred of them).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { create as createFont, type Font } from 'fontkit';
import subsetFont from 'subset-font';

import { formatUnicodeRange, toRanges } from './font-css';
import {
  HANZI_EXTRA,
  UI_EXTRA,
  headwordChars,
  pinyinChars,
  repoRoot,
  type CharFacts,
} from './font-charset';
import { fetchAll, vendored } from './font-fetch';
import {
  FONT_CSS,
  FONT_CSS_TO_OUT,
  FONT_OUT_DIR,
  SHIPPED,
  faceOf,
  type ShippedFamily,
  type SlicePlan,
} from './font-shipping';
import { VENDOR_DIR } from './fonts';

const ensure = process.argv.includes('--ensure');

const outDir = resolve(repoRoot, FONT_OUT_DIR);
const cssPath = resolve(repoRoot, FONT_CSS);

function binaryOf(family: string): Buffer {
  const face = faceOf(family);
  return readFileSync(resolve(repoRoot, VENDOR_DIR, face.dir, face.file));
}

/** The `wght` axis of a variable face, or `400 400` for a static one. */
function weightDescriptor(font: Font): string {
  const axis = (font.variationAxes as Record<string, { min: number; max: number }> | undefined)?.[
    'wght'
  ];
  if (!axis) return '400';
  return `${Math.round(axis.min)} ${Math.round(axis.max)}`;
}

/**
 * The characters this family is responsible for, ordered for slicing.
 *
 * Characters the source face has no glyph for are dropped here rather than
 * asked for: harfbuzz would silently produce nothing for them, and the
 * *coverage check* — not this script — is where a shortfall is supposed to be
 * reported. `font-coverage-check.ts` re-derives the same set from the same
 * module and compares it against the cmaps of what this wrote, so dropping here
 * cannot hide a shortfall there.
 */
function ordered(facts: CharFacts, extra: readonly string[], font: Font): string[] {
  const chars = new Set<string>([...facts.chars, ...extra]);
  const keep = [...chars].filter((ch) => font.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0));
  const UNRANKED = Number.MAX_SAFE_INTEGER;
  const cp = (ch: string) => ch.codePointAt(0) ?? 0;
  // A Set, not `extra.includes`: a comparator runs O(n log n) times over 14,700
  // characters and a linear scan of 190 inside it is forty million string
  // comparisons for a lookup that is O(1).
  const own = new Set(extra);
  return keep.sort((a, b) => {
    // `UI_EXTRA`, `APP_HANZI` and `HANZI_EXTRA` are the app's own text; it is on
    // every screen regardless of what the dictionary says, so it sorts ahead of
    // the dictionary's own most-frequent characters and lands in the first slice.
    const ea = own.has(a) ? 0 : 1;
    const eb = own.has(b) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const ra = facts.bestRank.get(a) ?? UNRANKED;
    const rb = facts.bestRank.get(b) ?? UNRANKED;
    if (ra !== rb) return ra - rb;
    return cp(a) - cp(b);
  });
}

/**
 * The head/tail cut (`scripts/font-shipping.ts`).
 *
 * `items` arrives in frequency order. The head takes `plan.head` from the front
 * in those graduated sizes; everything left is re-sorted by code point and cut
 * into `plan.tail`-sized runs, which is what makes its `unicode-range`
 * coalesce.
 */
function slice(items: readonly string[], plan: SlicePlan): string[][] {
  const out: string[][] = [];
  let at = 0;
  for (const size of plan.head) {
    if (at >= items.length) break;
    out.push(items.slice(at, at + size));
    at += size;
  }
  const tail = items
    .slice(at)
    .sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0));
  for (let i = 0; i < tail.length; i += plan.tail) out.push(tail.slice(i, i + plan.tail));
  return out;
}

interface Emitted {
  file: string;
  bytes: number;
  chars: string[];
  weight: string;
  family: string;
  /** Which vendored face supplied the glyphs — the source or the donor. */
  from: string;
}

async function cut(
  family: ShippedFamily,
  source: string,
  binary: Buffer,
  chars: readonly string[],
  file: string,
  weight: string,
): Promise<Emitted> {
  const out = await subsetFont(binary, chars.join(''), { targetFormat: 'woff2' });
  writeFileSync(resolve(outDir, file), out);
  return {
    file,
    bytes: out.byteLength,
    chars: [...chars],
    weight,
    family: family.family,
    from: source,
  };
}

async function emit(family: ShippedFamily): Promise<Emitted[]> {
  const facts = family.covers === 'headwords' ? headwordChars() : pinyinChars();
  const extra = family.covers === 'headwords' ? HANZI_EXTRA : UI_EXTRA;
  const binary = binaryOf(family.source);
  const font = createFont(binary) as Font;
  const weight = weightDescriptor(font);

  const chars = ordered(facts, extra, font);
  const emitted: Emitted[] = [];
  const slices = slice(chars, family.slices);
  for (const [i, part] of slices.entries()) {
    emitted.push(
      await cut(
        family,
        family.source,
        binary,
        part,
        `${family.slug}-${String(i).padStart(2, '0')}.woff2`,
        weight,
      ),
    );
  }

  /**
   * The donor slice. See `ShippedFamily.donor`: DM Sans and Newsreader have no
   * glyph for U+01CD–U+01DC, which is every third-tone vowel in marked pinyin.
   * Only the code points the source genuinely lacks go here, so the two ranges
   * are disjoint by construction and `font:check` can insist on it.
   */
  if (family.donor) {
    const donorBinary = binaryOf(family.donor);
    const donorFont = createFont(donorBinary) as Font;
    const missing = [...new Set([...facts.chars, ...extra])]
      .filter((ch) => !font.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0))
      .filter((ch) => donorFont.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0))
      .sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0));
    if (missing.length > 0) {
      emitted.push(
        await cut(
          family,
          family.donor,
          donorBinary,
          missing,
          `${family.slug}-donor.woff2`,
          // The PRIMARY's descriptor, not the donor's own axis. They differ —
          // DM Sans is `100 1000`, Noto Sans SC `100 900` — and a family whose
          // two faces claim different weight ranges has a band (here 900–1000)
          // where one face matches and the other does not, so a code point that
          // only the donor has would fall out of the family entirely at that
          // weight. Clamping a variable font to a wider declared range is
          // harmless; a gap in the family is not.
          weight,
        ),
      );
    }
  }

  return emitted;
}

function stylesheet(all: readonly Emitted[]): string {
  const header = `/*
 * GENERATED by \`pnpm font:subset\` (scripts/font-subset.ts, docs/plans/web.md W6).
 * Do not edit: the next build overwrites it. The .woff2 files it names are
 * generated too and are gitignored; this file is committed because it is the
 * reviewable manifest of what the app actually ships.
 *
 * Self-hosted and referenced with a RELATIVE url(), so Vite emits each file
 * into the content-hashed /assets/ directory that the service worker's
 * cache-first rule already covers. A file under public/fonts/ would keep its
 * authored name, match no worker rule at all, and be re-fetched on every load.
 *
 * Every face declares an exact unicode-range and \`pnpm font:check\` asserts that
 * the range matches the file's own cmap, that no two ranges in a family
 * overlap, and that the union covers the character set the family is
 * responsible for. See scripts/font-coverage-check.ts for why an exact claim
 * matters and why a rendered-width assertion cannot replace this.
 */\n\n`;
  const blocks = all.map((face) => {
    const ranges = formatUnicodeRange(
      toRanges(face.chars.map((ch) => ch.codePointAt(0) ?? 0)),
    );
    const kb = (face.bytes / 1024).toFixed(1);
    return (
      `/* ${face.file} — ${face.chars.length} code points, ${kb} KB, from ${face.from} */\n` +
      `@font-face {\n` +
      `  font-family: '${face.family}';\n` +
      `  font-style: normal;\n` +
      `  font-weight: ${face.weight};\n` +
      `  font-display: swap;\n` +
      `  src: url('${FONT_CSS_TO_OUT}/${face.file}') format('woff2');\n` +
      `  unicode-range: ${ranges};\n` +
      `}\n`
    );
  });
  return header + blocks.join('\n');
}

function outputsPresent(): boolean {
  if (!existsSync(cssPath) || !existsSync(outDir)) return false;
  return readdirSync(outDir).some((name) => name.endsWith('.woff2'));
}

async function main(): Promise<void> {
  if (ensure && outputsPresent()) {
    process.stdout.write(`font:ensure — ${FONT_CSS} and ${FONT_OUT_DIR} are present; nothing to do\n`);
    return;
  }
  if (!vendored()) {
    process.stdout.write(`font:subset — a vendored binary is missing; fetching first\n`);
    await fetchAll();
  }

  mkdirSync(outDir, { recursive: true });
  // A slice count that shrinks must not leave last run's files behind: they
  // would still be referenced by nothing, but they would also still be counted
  // by anything that measures the directory.
  for (const name of readdirSync(outDir)) {
    if (name.endsWith('.woff2')) rmSync(resolve(outDir, name));
  }

  process.stdout.write(`font:subset → ${outDir}\n`);
  const all: Emitted[] = [];
  for (const family of SHIPPED) {
    const emitted = await emit(family);
    all.push(...emitted);
    const total = emitted.reduce((n, face) => n + face.bytes, 0);
    const chars = emitted.reduce((n, face) => n + face.chars.length, 0);
    process.stdout.write(
      `  ${family.family.padEnd(14)} ${String(emitted.length).padStart(2)} file(s)  ` +
        `${chars.toLocaleString('en-US').padStart(7)} code points  ` +
        `${(total / 1024 / 1024).toFixed(2)} MB\n`,
    );
    for (const face of emitted) {
      process.stdout.write(
        `      ${face.file.padEnd(26)} ${String(face.chars.length).padStart(6)} cp  ` +
          `${(face.bytes / 1024).toFixed(1).padStart(8)} KB\n`,
      );
    }
  }

  writeFileSync(cssPath, stylesheet(all));
  const total = all.reduce((n, face) => n + face.bytes, 0);
  process.stdout.write(
    `\n  ${all.length} files, ${(total / 1024 / 1024).toFixed(2)} MB total\n` +
      `  wrote ${cssPath}\n` +
      `\nThat total is what a learner downloads only if they render every character in\n` +
      `the dictionary. What a page costs is the slices its own text touches — run\n` +
      `\`pnpm font:check\` for the per-slice table and HANDOFF.md for the budget.\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `font:subset failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
