/**
 * The font manifest — what `pnpm font:fetch` downloads and what
 * `pnpm font:coverage` measures (docs/plans/core.md C0, register #9).
 *
 * One module because the two scripts must not disagree about which file is
 * which face. The stacks below are the same stacks `apps/app/app/tokens.css`
 * declares, transcribed here with the *measurable* faces marked: a system
 * fallback like "Songti SC" has no binary anyone can fetch, so the coverage
 * number a stack can actually produce is the union of its vendored faces. The
 * report says so rather than implying the system fallbacks were checked.
 *
 * Licences travel with the binaries. All three families are SIL OFL 1.1 and the
 * OFL requires the licence to ship alongside, so `font:fetch` writes the
 * family's `OFL.txt` next to its binary and those licence files are COMMITTED
 * (the binaries are not — `.gitignore` carries `vendor/fonts/**` minus the
 * licences), exactly the way `data/COPYING-makemeahanzi` is committed next to a
 * generated `data/decomp.json`.
 *
 * Reproducibility without a git pin. api.github.com is blocked from this
 * container (docs/data-sources.md) so a commit SHA cannot be resolved at fetch
 * time; instead each face carries the sha256 of the bytes that were actually
 * measured, and `font:fetch` refuses a file whose digest does not match unless
 * `--accept-new-digest` is passed. A silently updated upstream is then a failed
 * fetch rather than a coverage number that quietly means something else.
 */

export interface FontFace {
  /** The CSS family name this binary IS, as written in the stacks below. */
  family: string;
  /** `vendor/fonts/<dir>/<file>`. */
  dir: string;
  file: string;
  url: string;
  /** sha256 of the bytes measured for HANDOFF.md's numbers. */
  sha256: string;
  /** Committed next to the binary. */
  licenseFile: string;
  licenseUrl: string;
  /** For the report: what a build would actually ship. */
  note: string;
}

/**
 * Google Fonts' own builds, from `google/fonts`, because those are the bytes a
 * web delivery would serve and `web.md`'s first-load budget is the consumer.
 * The upstream `notofonts/noto-cjk` OTFs are a different (larger, more
 * complete) build; if a later phase wants that number too, add the face here
 * rather than measuring it by hand.
 */
export const FACES: readonly FontFace[] = [
  {
    family: 'Noto Serif SC',
    dir: 'noto-serif-sc',
    file: 'NotoSerifSC[wght].ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf',
    sha256: '050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9',
    licenseFile: 'OFL.txt',
    licenseUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/OFL.txt',
    note: 'variable weight 200-900; the hanzi face',
  },
  {
    family: 'Noto Sans SC',
    dir: 'noto-sans-sc',
    file: 'NotoSansSC[wght].ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
    licenseFile: 'OFL.txt',
    licenseUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt',
    note: 'variable weight 100-900; measured as the sans alternative, not declared in a stack',
  },
  {
    family: 'Newsreader',
    dir: 'newsreader',
    file: 'Newsreader[opsz,wght].ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader%5Bopsz%2Cwght%5D.ttf',
    sha256: '8a08d13f8a6c0d51be379a60af84f945f65369a67e509ee3c3bdcc421254d7c1',
    licenseFile: 'OFL.txt',
    licenseUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/OFL.txt',
    note: 'variable optical size + weight; the display face',
  },
  {
    family: 'DM Sans',
    dir: 'dm-sans',
    file: 'DMSans[opsz,wght].ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf',
    sha256: '8cd08d97e89c24d0aa92edd2f0f4c8ee6195eee9b7c9f154865a58b02f0c1c0d',
    licenseFile: 'OFL.txt',
    licenseUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/dmsans/OFL.txt',
    note: 'variable optical size + weight; the UI face',
  },
];

export interface FontStack {
  /** The CSS custom property in `apps/app/app/tokens.css`. */
  token: string;
  /** The families in the declared stack, in order. */
  declared: readonly string[];
  /**
   * Which of `declared` have a binary in FACES. The rest are system faces this
   * container has no copy of, and the report never counts them as coverage.
   */
  measurable: readonly string[];
  /**
   * Whether a shortfall in this stack fails the script. A stack that renders
   * hanzi must cover the dictionary or a reader sees tofu; the Latin stacks
   * render UI chrome and are reported, never failed, because the headword
   * character set is not what they are for.
   */
  gate: boolean;
}

export const STACKS: readonly FontStack[] = [
  {
    token: '--font-hanzi',
    declared: [
      'Noto Serif SC',
      'Source Han Serif SC',
      'Songti SC',
      'STSong',
      'Noto Serif CJK SC',
      'PingFang SC',
      'Microsoft YaHei',
      'ui-serif',
      'serif',
    ],
    measurable: ['Noto Serif SC'],
    gate: true,
  },
  {
    token: '--font-display',
    declared: ['Newsreader', 'ui-serif', 'Georgia', 'Times New Roman', 'serif'],
    measurable: ['Newsreader'],
    gate: false,
  },
  {
    token: '--font-ui',
    declared: [
      'DM Sans',
      'ui-sans-serif',
      'system-ui',
      '-apple-system',
      'Segoe UI',
      'Roboto',
      'Helvetica Neue',
      'Arial',
      'sans-serif',
    ],
    measurable: ['DM Sans'],
    gate: false,
  },
];

/** `vendor/fonts` under the workspace root. Gitignored except the licences. */
export const VENDOR_DIR = 'vendor/fonts';
