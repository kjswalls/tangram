/**
 * `subset-font` 2.7 ships no types (`package.json` has `main` and nothing else),
 * and `@types/subset-font` does not exist. This is the slice of its API that
 * `scripts/font-subset.ts` uses, written against the package's own README and
 * `index.js`.
 *
 * It is deliberately narrow. A `declare module 'subset-font';` — the suggestion
 * TypeScript itself prints — would type the call as `any`, which is how a
 * mistyped option silently does nothing and the fonts come out subtly wrong.
 */
declare module 'subset-font' {
  interface VariationAxisRange {
    min?: number;
    max?: number;
    default?: number;
  }

  interface SubsetOptions {
    /** `'sfnt' | 'woff' | 'woff2'`. Defaults to the input's format. */
    targetFormat?: 'sfnt' | 'woff' | 'woff2';
    /** Pin or clamp a variation axis; omit to keep the axis whole. */
    variationAxes?: Record<string, VariationAxisRange>;
    /** OpenType features to preserve beyond the defaults. */
    preserveNameIds?: number[];
  }

  /**
   * Cut `font` down to the glyphs `text` needs and re-encode it.
   *
   * `text` is a plain string: every code point in it is requested, and a code
   * point the source has no glyph for is silently absent from the result — which
   * is why `scripts/font-coverage-check.ts` re-reads the output's `cmap` rather
   * than trusting this call to have succeeded.
   */
  export default function subsetFont(
    font: Buffer | Uint8Array,
    text: string,
    options?: SubsetOptions,
  ): Promise<Buffer>;
}
