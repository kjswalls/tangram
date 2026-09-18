/**
 * What `web.md` W6 actually ships, as data (docs/plans/web.md W6).
 *
 * `scripts/fonts.ts` is C0's: it says which *candidate* binaries exist and which
 * stacks `apps/app/app/tokens.css` declares. This file says which of them
 * becomes a `@font-face` in `apps/app/src/styles/fonts.css`, cut how, covering
 * what. Kept apart so that C0's manifest — which a unit test ties to
 * `tokens.css` — is not edited by a phase that only wants to change how the
 * bytes are delivered.
 *
 * **Self-hosted, not a CDN**, and W6 gives three reasons that all bite here: an
 * offline-first app cannot depend on a third origin, the service worker's
 * storability test is `response.type === 'basic'` (same-origin), and Capacitor
 * and Tauri serve `dist/` from a local scheme a CDN cannot reach.
 *
 * **Through the module graph, not `publicDir`.** Files under `public/fonts/`
 * keep their authored names, get no content hash, and are matched by the
 * worker's rule 2 (wrong prefix — it is `/assets/`) and by rule 3 (not a
 * navigation): that is, by nothing, so the worker never stores them and W6's
 * "zero font requests on second load" cannot pass. Referenced from
 * `src/styles/fonts.css` with a relative `url()`, Vite emits them into the
 * hashed asset directory rule 2 already covers.
 *
 * ---
 *
 * **One variable file per slice, not two static weights, and here is the
 * arithmetic** (measured on this tree, `subset-font` 2.7 over harfbuzz, the
 * 14,598 headword characters Noto Serif SC actually has glyphs for):
 *
 * | cut | total woff2 | per character |
 * |---|---|---|
 * | variable, `wght` 200–900 | 5.45 MB | 384 B |
 * | static instance at 400 | 2.83 MB | 198 B |
 * | two static instances (400 + 500) | 5.66 MB | 388 B |
 *
 * The app renders hanzi at 400 and at 500 (`font-medium` on the practice card
 * and the reader's title), and STACK §2.1 requires a **real** bold weight
 * because Android WebView 139–140 stopped synthesising bold for CJK. Two static
 * weights cost more than the whole variable range and still synthesise
 * everything else, so the variable file wins on both size and correctness. It
 * is also one request per slice instead of two.
 *
 * ---
 *
 * **The slice plan, and why it is two plans.** A page downloads only the slices
 * its own text touches, so the slices have to follow *frequency* — the common
 * characters are scattered across the whole CJK block and a code-point cut
 * would make every page fetch almost every slice. But frequency order is also
 * what makes `unicode-range` expensive to *write*: a slice of 768 scattered
 * code points coalesces into ~768 range tokens, and cutting all 14,653 that way
 * produced a **108 KB** stylesheet (40 KB gzipped) in front of first paint —
 * more than the whole app's CSS, to save bytes later.
 *
 * So: the **head** is cut by frequency, in graduated sizes, because that is the
 * part a first paint actually renders; the **tail** is cut by code point, which
 * coalesces into real ranges and costs almost nothing to declare. The head is
 * the 1,664 most frequent characters, which is far past the point where running
 * text stops finding anything new; a learner who reaches the tail is looking up
 * something rare, with the dictionary already loaded. The same stylesheet is
 * **25 KB** (6 KB gzipped) under this split.
 */
import { FACES, type FontFace } from './fonts';

export interface ShippedFamily {
  /**
   * The CSS family name, **exactly** as `apps/app/app/tokens.css` declares it
   * in its stack. A mismatch here is a family nothing references, which renders
   * as "the fallback was used and nothing failed".
   */
  family: string;
  /** File-name prefix under `apps/app/src/fonts/`. */
  slug: string;
  /** The vendored face whose glyphs are cut. `scripts/fonts.ts` `FACES`. */
  source: string;
  /** Which set of `scripts/font-charset.ts` this family must cover. */
  covers: 'headwords' | 'pinyin';
  /** Whether a shortfall fails `pnpm font:check`. */
  gate: boolean;
  /** How this family's characters are cut. See the header. */
  slices: SlicePlan;
  /**
   * A second vendored face supplying code points `source` has no glyph for.
   *
   * **This is not a nicety and W6 found it by measuring.** DM Sans and
   * Newsreader both lack U+01CD–U+01DC — Ǎ ǎ Ǐ ǐ Ǒ ǒ Ǔ ǔ Ǖ ǖ Ǘ ǘ Ǚ ǚ Ǜ ǜ —
   * which is *every third-tone vowel and every tone on ü* in marked pinyin.
   * Before W6 nothing was self-hosted, so the whole stack was a system-font
   * gamble and at least it was a consistent one; self-hosting DM Sans without
   * this would have made third-tone pinyin the one thing on the screen drawn by
   * a different font, or tofu on a device whose system fonts have no Latin
   * Extended-B. The donor is matched by style — Noto Sans SC's Latin for DM
   * Sans, Noto Serif SC's for Newsreader — and covers those code points only.
   */
  donor?: string;
}

export interface SlicePlan {
  /** Sizes of the frequency-ordered slices, most frequent first. */
  head: readonly number[];
  /** Size of each code-point-ordered slice covering what the head left. */
  tail: number;
}

/** See the header. */
const HANZI_SLICES: SlicePlan = { head: [128, 256, 512, 768], tail: 768 };
/** The Latin faces are a few dozen KB whole; slicing them would buy nothing. */
const LATIN_SLICES: SlicePlan = { head: [], tail: 4096 };

export const SHIPPED: readonly ShippedFamily[] = [
  {
    family: 'Noto Serif SC',
    slug: 'noto-serif-sc',
    source: 'Noto Serif SC',
    covers: 'headwords',
    gate: true,
    slices: HANZI_SLICES,
  },
  {
    family: 'DM Sans',
    slug: 'dm-sans',
    source: 'DM Sans',
    covers: 'pinyin',
    gate: true,
    slices: LATIN_SLICES,
    donor: 'Noto Sans SC',
  },
  {
    family: 'Newsreader',
    slug: 'newsreader',
    source: 'Newsreader',
    covers: 'pinyin',
    gate: true,
    slices: LATIN_SLICES,
    donor: 'Noto Serif SC',
  },
];

export function faceOf(family: string): FontFace {
  const face = FACES.find((candidate) => candidate.family === family);
  if (!face) throw new Error(`scripts/fonts.ts has no face named ${family}`);
  return face;
}

/** Where the cut files and the stylesheet that names them live. */
export const FONT_OUT_DIR = 'apps/app/src/fonts';
export const FONT_CSS = 'apps/app/src/styles/fonts.css';
/** From `FONT_CSS`'s directory to `FONT_OUT_DIR`. */
export const FONT_CSS_TO_OUT = '../fonts';
