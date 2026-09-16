/**
 * `pnpm font:check` — do the fonts the app SHIPS cover what it renders?
 * (docs/plans/web.md W6, acceptance criterion 2.)
 *
 * `pnpm font:coverage` (C0) answers a different question: does a *candidate*
 * binary, whole, have the glyphs. This answers the one W6 is gated on: after the
 * cut, after the `unicode-range` split, after the stylesheet was written — for
 * every character a learner can be shown, is there a shipped file that has the
 * glyph AND a `@font-face` whose range points the browser at it.
 *
 * **It reads `cmap` tables, never rendered width, and the plan is explicit about
 * why.** A missing glyph renders as `.notdef` — the tofu box — which has a
 * *non-zero advance width*, so a "width > 0" assertion passes on precisely the
 * failure it is written to catch. Nothing here measures a rendered anything.
 *
 * **Four assertions, per family, per declared weight range.** Three of them are
 * about the `unicode-range` split rather than the glyphs, because CSS font
 * matching makes an inexact range as bad as a missing glyph: for a given code
 * point the engine picks the *first* `@font-face` in the family whose range
 * contains it, and if that file has no glyph it falls through to the **next
 * family in the stack** — not to the next `@font-face`. So:
 *
 *   1. **Covered.** The union of the cmaps, across every file declared for this
 *      family at this weight, contains every character the family is
 *      responsible for — minus a reviewed residue (`scripts/font-residue.json`,
 *      C0's baseline), none of which may carry a jieba frequency rank.
 *   2. **Honest.** Every code point a face *claims* in its `unicode-range` is
 *      one its file actually has. An over-claim silently routes the browser to a
 *      file that cannot answer.
 *   3. **Disjoint.** No two faces of the same family and weight claim the same
 *      code point. An overlap means the file that wins is decided by source
 *      order rather than by which one has the glyph.
 *   4. **Reachable.** Every character the family is responsible for and has a
 *      glyph for is inside some declared range. A glyph nothing points at is
 *      bytes shipped and never used, and the character renders from the
 *      fallback stack anyway.
 *
 * **And the weights.** The grouping key is (family, `font-weight` descriptor),
 * so "a weight that ships without its subset" is a shortfall in a group rather
 * than something averaged away — and a family whose faces declare *different*
 * weight ranges fails assertion 1 for the band only one of them covers.
 *
 * It fails with **the list of uncovered code points**, with their frequency
 * rank, not a boolean. `tests/unit/fonts/coverage.test.ts` runs the same
 * function, because CLAUDE.md says a rule that wants enforcement in this repo
 * is a unit test — there is no CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { create as createFont, type Font } from 'fontkit';

import { expand, parseFontFaces, type ParsedFace } from './font-css';
import {
  HANZI_EXTRA,
  UI_EXTRA,
  headwordChars,
  pinyinChars,
  repoRoot,
  type CharFacts,
} from './font-charset';
import { FONT_CSS, SHIPPED, type ShippedFamily } from './font-shipping';

const BASELINE_PATH = resolve(repoRoot, 'scripts/font-residue.json');

interface Baseline {
  allowed: Record<string, string[]>;
}

/**
 * C0's reviewed residue, keyed by the `tokens.css` token. W6 reads the same
 * file rather than starting a second list: the 79 astral-plane characters no
 * shipped face has a glyph for are the same 79 whatever cuts them.
 */
function residueFor(token: string): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  return new Set(baseline.allowed[token] ?? []);
}

/** `--font-hanzi` is the gated stack C0 measures; the Latin stacks are the two others. */
const TOKEN_OF: Record<string, string> = {
  'Noto Serif SC': '--font-hanzi',
  'DM Sans': '--font-ui',
  Newsreader: '--font-display',
};

export interface FaceReport {
  file: string;
  bytes: number;
  /** Code points the file's cmap has, restricted to the family's set. */
  glyphs: number;
  /** Code points the `unicode-range` claims. */
  claimed: number;
}

export interface GroupReport {
  family: string;
  weight: string;
  faces: FaceReport[];
  /** Characters the family is responsible for. */
  responsible: number;
  /** Uncovered, excluding the reviewed residue, worst (most frequent) first. */
  uncovered: string[];
  /** Uncovered AND carrying a jieba rank — the failure that always matters. */
  ranked: string[];
  /** Code points claimed by a face whose file has no glyph for them. */
  overclaimed: string[];
  /** Code points claimed by more than one face in this group. */
  overlapping: string[];
  /** Glyphs shipped that no declared range points at. */
  unreachable: string[];
  gate: boolean;
}

export interface CheckResult {
  groups: GroupReport[];
  problems: string[];
  cssBytes: number;
  totalBytes: number;
}

function code(ch: string): number {
  return ch.codePointAt(0) ?? 0;
}

function describe(chars: readonly string[], ranks: Map<string, number>, limit = 40): string {
  const sorted = [...chars].sort(
    (a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity) || code(a) - code(b),
  );
  const shown = sorted.slice(0, limit).map((ch) => {
    const rank = ranks.get(ch);
    const hex = code(ch).toString(16).toUpperCase().padStart(4, '0');
    const ranked = rank !== undefined && rank < Number.MAX_SAFE_INTEGER ? ` #${rank}` : '';
    return `${ch} U+${hex}${ranked}`;
  });
  const rest = sorted.length - shown.length;
  return shown.join('  ') + (rest > 0 ? `  … and ${rest} more` : '');
}

/**
 * The set a family is responsible for: the dictionary's characters for its
 * stack, plus the app's own text, **minus the ones no vendored binary has a
 * glyph for at all**. That last subtraction is the reviewed residue and it is
 * read from C0's committed baseline, never recomputed here — a check that
 * derives its own excuse list has no gate in it.
 */
function responsibleFor(family: ShippedFamily): { facts: CharFacts; chars: Set<string> } {
  const facts = family.covers === 'headwords' ? headwordChars() : pinyinChars();
  const extra = family.covers === 'headwords' ? HANZI_EXTRA : UI_EXTRA;
  return { facts, chars: new Set([...facts.chars, ...extra]) };
}

export function check(): CheckResult {
  const cssPath = resolve(repoRoot, FONT_CSS);
  if (!existsSync(cssPath)) {
    throw new Error(`${FONT_CSS} is missing. Run \`pnpm font:subset\`.`);
  }
  const cssDir = dirname(cssPath);
  const css = readFileSync(cssPath, 'utf8');
  const faces = parseFontFaces(css);
  if (faces.length === 0) throw new Error(`${FONT_CSS} declares no @font-face at all.`);

  const problems: string[] = [];
  const groups: GroupReport[] = [];
  let totalBytes = 0;

  const byFamily = new Map<string, ParsedFace[]>();
  for (const face of faces) {
    byFamily.set(face.family, [...(byFamily.get(face.family) ?? []), face]);
  }

  for (const family of byFamily.keys()) {
    if (!SHIPPED.some((shipped) => shipped.family === family)) {
      problems.push(
        `${FONT_CSS} declares a family (${family}) that scripts/font-shipping.ts does not ship. ` +
          `Either the stylesheet is stale or the manifest is.`,
      );
    }
  }

  for (const shipped of SHIPPED) {
    const declared = byFamily.get(shipped.family) ?? [];
    if (declared.length === 0) {
      problems.push(
        `${shipped.family} is in scripts/font-shipping.ts but has no @font-face in ${FONT_CSS}. ` +
          `The stack in tokens.css names it, so every character it was meant to cover renders ` +
          `from the system fallback.`,
      );
      continue;
    }

    const { facts, chars: responsible } = responsibleFor(shipped);
    const residue = residueFor(TOKEN_OF[shipped.family] ?? '');

    // Group by the weight descriptor, so a weight that ships without its subset
    // is a shortfall rather than something the union hides.
    const byWeight = new Map<string, ParsedFace[]>();
    for (const face of declared) {
      byWeight.set(face.weight, [...(byWeight.get(face.weight) ?? []), face]);
    }

    for (const [weight, inGroup] of byWeight) {
      const reports: FaceReport[] = [];
      const covered = new Set<string>();
      /** Every character in this group that SOME file has a glyph for. */
      const shippedGlyphs = new Set<string>();
      const claimedBy = new Map<number, string[]>();
      const overclaimed: string[] = [];

      for (const face of inGroup) {
        const path = resolve(cssDir, face.src);
        if (!existsSync(path)) {
          problems.push(
            `${FONT_CSS} @font-face #${face.index} (${face.family}) points at ${face.src}, ` +
              `which does not exist. Run \`pnpm font:subset\`.`,
          );
          continue;
        }
        const bytes = readFileSync(path);
        totalBytes += bytes.byteLength;
        // One parse per FILE, never one per character: the naive shape of this
        // loop re-parses a 350 KB woff2 fourteen thousand times.
        const font = createFont(bytes) as Font;
        const claimed = expand(face.unicodeRange);
        for (const cp of claimed) {
          claimedBy.set(cp, [...(claimedBy.get(cp) ?? []), face.src]);
          // Assertion 2: an over-claim routes the browser here and it cannot
          // answer, and the engine will NOT try the next @font-face.
          if (!font.hasGlyphForCodePoint(cp)) overclaimed.push(String.fromCodePoint(cp));
        }
        let glyphs = 0;
        for (const ch of responsible) {
          if (!font.hasGlyphForCodePoint(code(ch))) continue;
          glyphs += 1;
          shippedGlyphs.add(ch);
          // Assertion 1 counts a character as covered only when a range also
          // points at it — a glyph nobody can reach is not coverage.
          if (claimed.has(code(ch))) covered.add(ch);
        }
        reports.push({ file: face.src, bytes: bytes.byteLength, glyphs, claimed: claimed.size });
      }

      const overlapping = [...claimedBy]
        .filter(([, srcs]) => srcs.length > 1)
        .map(([cp]) => String.fromCodePoint(cp));

      const unreachable = [...shippedGlyphs].filter((ch) => !covered.has(ch));

      const uncovered = [...responsible].filter((ch) => !covered.has(ch) && !residue.has(ch));
      const ranked = [...responsible]
        .filter((ch) => !covered.has(ch))
        .filter((ch) => (facts.bestRank.get(ch) ?? Number.MAX_SAFE_INTEGER) < Number.MAX_SAFE_INTEGER);

      groups.push({
        family: shipped.family,
        weight,
        faces: reports,
        responsible: responsible.size,
        uncovered,
        ranked,
        overclaimed: [...new Set(overclaimed)],
        overlapping,
        unreachable,
        gate: shipped.gate,
      });

      if (!shipped.gate) continue;
      const where = `${shipped.family} at font-weight ${weight}`;
      if (ranked.length > 0) {
        problems.push(
          `${where}: ${ranked.length} character(s) that a ranked word uses have no shipped glyph ` +
            `reachable through a declared unicode-range, so a word a learner can meet renders as ` +
            `tofu:\n    ${describe(ranked, facts.bestRank)}`,
        );
      }
      if (uncovered.length > 0) {
        problems.push(
          `${where}: ${uncovered.length} character(s) are uncovered and are not in the reviewed ` +
            `residue (scripts/font-residue.json):\n    ${describe(uncovered, facts.bestRank)}`,
        );
      }
      if (overclaimed.length > 0) {
        problems.push(
          `${where}: ${new Set(overclaimed).size} code point(s) are claimed by a unicode-range ` +
            `whose file has no glyph for them. CSS font matching will pick that face and then ` +
            `fall through to the next FAMILY, not to the next @font-face:\n    ` +
            `${describe([...new Set(overclaimed)], facts.bestRank)}`,
        );
      }
      if (overlapping.length > 0) {
        problems.push(
          `${where}: ${overlapping.length} code point(s) are claimed by more than one face, so ` +
            `which file answers is decided by source order:\n    ` +
            `${describe(overlapping, facts.bestRank)}`,
        );
      }
      if (unreachable.length > 0) {
        problems.push(
          `${where}: ${unreachable.length} character(s) have a shipped glyph that no declared ` +
            `unicode-range points at — the bytes ship and the character still renders from the ` +
            `fallback stack:\n    ${describe(unreachable, facts.bestRank)}`,
        );
      }
    }
  }

  return { groups, problems, cssBytes: Buffer.byteLength(css), totalBytes };
}

function main(): void {
  const result = check();
  process.stdout.write(`font:check — ${FONT_CSS}\n\n`);
  for (const group of result.groups) {
    const total = group.faces.reduce((n, face) => n + face.bytes, 0);
    process.stdout.write(
      `  ${group.family} @ font-weight ${group.weight}  [${group.gate ? 'GATED' : 'reported'}]\n` +
        `    ${group.faces.length} file(s), ${(total / 1024 / 1024).toFixed(2)} MB, ` +
        `${group.responsible.toLocaleString('en-US')} characters to cover, ` +
        `${group.uncovered.length} uncovered beyond the reviewed residue\n`,
    );
  }
  process.stdout.write(
    `\n  stylesheet ${(result.cssBytes / 1024).toFixed(1)} KB, ` +
      `font files ${(result.totalBytes / 1024 / 1024).toFixed(2)} MB total\n`,
  );
  if (result.problems.length > 0) {
    process.stdout.write(`\n${result.problems.length} problem(s):\n\n`);
    for (const problem of result.problems) process.stdout.write(`  ${problem}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `\nOK. Every character each family is responsible for has a shipped glyph, reachable\n` +
      `through exactly one declared unicode-range, at every weight the family declares —\n` +
      `asserted against cmap tables, never against rendered width.\n`,
  );
}

// Runnable as `pnpm font:check`; imported (and not run) by the unit test.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
