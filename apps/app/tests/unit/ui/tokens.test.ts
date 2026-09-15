/**
 * The token layer, asserted (docs/plans/core.md C0).
 *
 * **Why the source and not `getComputedStyle`.** jsdom resolves neither
 * `var()` chains nor `@media` cascades for custom properties, so a computed
 * assertion here would pass against an empty stylesheet. The values ARE
 * asserted against a real engine — `tests/e2e/core/theme.spec.ts` reads
 * `getComputedStyle` in Chromium, in every theme state — and this file asserts
 * the things an engine cannot: the *structure* that makes the palette
 * swappable, that the ten settled hexes are the ones the file carries, and
 * three guards that exist because the C0 review found the failures they catch.
 *
 * C0's own note applies to the last group and is repeated so nobody reads it as
 * evidence: the no-raw-hex grep already returned nothing before C0, so it is a
 * regression guard, not proof that C0 happened. The value tests are the proof.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workspaceRoot = resolve(appRoot, '..', '..');
const TOKENS_PATH = join(appRoot, 'app', 'tokens.css');
const SELF = fileURLToPath(import.meta.url);
const TIER_1_PREFIX = `--${'t1'}-`;
const tokens = readFileSync(TOKENS_PATH, 'utf8');
/** Comments first, always: a `--foo: bar` inside prose is not a declaration. */
const tokensCode = tokens.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------------------
// A CSS block reader small enough to trust
//
// The first version of this anchored on `indexOf(selector)` over the raw
// source, which matched the selector's first mention *inside the header
// comment* and read only the first matching block. Both were review findings:
// a brace in a comment, or a second `:root {`, would have changed the palette
// while all 21 tests passed. It now parses the comment-stripped source, anchors
// on a real selector, and MERGES every matching block in source order — which
// is what the cascade does.

interface Block {
  declarations: Record<string, string>;
  count: number;
}

function blocks(selector: RegExp, source = tokensCode): Block {
  const declarations: Record<string, string> = {};
  let count = 0;
  const pattern = new RegExp(selector.source, `${selector.flags.replace('g', '')}g`);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf('{', match.index + match[0].length - 1);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    count += 1;
    for (const line of source.slice(open + 1, end).split(';')) {
      const declaration = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(line);
      if (declaration) declarations[declaration[1]] = declaration[2].trim();
    }
    pattern.lastIndex = end;
  }
  return { declarations, count };
}

/** The dark block nested inside the `prefers-color-scheme` at-rule. */
function mediaDark(): Block {
  const at = tokensCode.indexOf('@media (prefers-color-scheme: dark)');
  expect(at, 'a prefers-color-scheme block must exist').toBeGreaterThan(-1);
  return blocks(/:root\[data-theme='system'\]\s*\{/, tokensCode.slice(at));
}

const rootBlock = blocks(/(?:^|[};])\s*:root\s*\{/m);
const light = rootBlock.declarations;
const darkExplicit = blocks(/:root\[data-theme='dark'\]\s*\{/).declarations;
const darkMediaBlock = mediaDark();
const darkMedia = darkMediaBlock.declarations;
const theme = blocks(/@theme inline\s*\{/).declarations;

/** Follow `var(--t1-x)` chains down to a literal. */
function resolveValue(name: string, scope: Record<string, string> = light): string {
  const seen = new Set<string>();
  let value = scope[name] ?? light[name];
  while (value !== undefined) {
    const match = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
    if (!match) return value;
    if (seen.has(match[1])) throw new Error(`cycle resolving ${name}`);
    seen.add(match[1]);
    value = scope[match[1]] ?? light[match[1]];
  }
  throw new Error(`${name} does not resolve`);
}

const SEMANTIC_COLOURS = [
  'paper',
  'surface',
  'ink',
  'muted',
  'border',
  'practice',
  'practice-soft',
  'lookup',
  'lookup-soft',
  'new',
  'new-soft',
  'warning',
  'warning-soft',
  'skeleton',
  'on-accent',
] as const;

const RADII = ['--r-sm', '--r-md', '--r-lg'];
const FAMILIES = ['--font-display', '--font-ui', '--font-hanzi'];
const SEMANTIC_TOKENS = [
  ...SEMANTIC_COLOURS.map((name) => `--${name}`),
  ...RADII,
  ...FAMILIES,
];

/** Files worth walking, workspace-wide. */
function sources(root: string, extensions: RegExp): string[] {
  const skip = new Set([
    'node_modules',
    'dist',
    'dist-no-gallery',
    '.git',
    'vendor',
    'test-results',
    'playwright-report',
    '.playwright',
    'data',
  ]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (extensions.test(name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Block and line comments removed, so a `var(--x)` written *about* a token in
 * prose is not read as a use of it. `//` preceded by `:` is left alone so a URL
 * does not swallow the rest of its line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the values are the point, so assert the values', () => {
  /** product-decisions §11's settled hexes, verbatim. */
  it.each([
    ['--paper', '#f8f4ec'],
    ['--surface', '#fffdf9'],
    ['--ink', '#1c1a17'],
    ['--muted', '#7a7469'],
    ['--border', '#e0d8ca'],
    ['--practice', '#b93a26'],
    ['--lookup', '#0f766e'],
    ['--lookup-soft', '#d9ece6'],
    ['--new', '#8a6414'],
    ['--new-soft', '#f3ead3'],
  ])('%s is %s in the light palette', (token, hex) => {
    expect(resolveValue(token)).toBe(hex);
  });

  it('--practice-soft is the value C0 proposed for the one settled-palette gap', () => {
    // §11 gives a soft tint for jade and gold and none for vermillion. If the
    // owner replaces it in C0's review, change it here and in HANDOFF.md
    // together — the point of the test is that nobody changes it by accident.
    expect(resolveValue('--practice-soft')).toBe('#ffe8e3');
  });

  it('the radius scale is 12 / 16 / 24', () => {
    expect(RADII.map((name) => resolveValue(name))).toEqual(['12px', '16px', '24px']);
  });
});

describe('the three theme states', () => {
  it('there is exactly one bare :root block', () => {
    // A second one would silently win on every token it repeated, and the
    // merged reader above would hide it from every other test here.
    expect(rootBlock.count).toBe(1);
  });

  it('every semantic token is defined on bare :root', () => {
    for (const token of SEMANTIC_TOKENS) expect(light, token).toHaveProperty(token);
  });

  it('every token redefined in a dark block also exists in the light block', () => {
    for (const source of [darkExplicit, darkMedia]) {
      for (const token of Object.keys(source)) expect(light, token).toHaveProperty(token);
    }
  });

  it('the prefers-color-scheme block and the [data-theme=dark] block define the same token set', () => {
    expect(Object.keys(darkMedia).sort()).toEqual(Object.keys(darkExplicit).sort());
    // and the same values, or the two paths to "dark" are two palettes
    for (const [token, value] of Object.entries(darkExplicit)) {
      expect(darkMedia[token], token).toBe(value);
    }
  });

  it('the dark blocks redefine every colour, and no radius or family', () => {
    for (const name of SEMANTIC_COLOURS) {
      expect(darkExplicit, `--${name}`).toHaveProperty(`--${name}`);
    }
    for (const token of [...RADII, ...FAMILIES]) expect(darkExplicit).not.toHaveProperty(token);
  });

  /**
   * wave-zero.md §10c: Inkstone is the default and the dark variant is not.
   * core.md C0 rule 1 says an unset `data-theme` follows the system; wave-zero
   * governs, so the media block is reached only through an explicit opt-in.
   * Without this test the two readings are indistinguishable in the source.
   */
  it('the media block is gated behind an explicit [data-theme=system] opt-in', () => {
    expect(darkMediaBlock.count).toBe(1);
    const at = tokensCode.indexOf('@media (prefers-color-scheme: dark)');
    const body = tokensCode.slice(at, tokensCode.indexOf('\n}', at));
    expect(body).toContain("[data-theme='system']");
    // Belt and braces: no bare `:root {` inside the media block, which would
    // make dark the default on a dark-preferring device.
    expect(body).not.toMatch(/(?:^|[};])\s*:root\s*\{/m);
  });
});

describe('the tiering is enforced, not just described', () => {
  it('every --color-* mapping resolves to a tier-2 semantic token', () => {
    const colours = Object.entries(theme).filter(([name]) => name.startsWith('--color-'));
    expect(colours.length).toBeGreaterThan(10);
    for (const [name, value] of colours) {
      const match = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
      expect(match, `${name} must be var(--semantic-token), got ${value}`).not.toBeNull();
      const target = match?.[1] ?? '';
      expect(target.startsWith(TIER_1_PREFIX), `${name} reaches tier 1 directly`).toBe(false);
      expect(SEMANTIC_TOKENS, `${name} → ${target}`).toContain(target);
    }
  });

  it('no tier-1 palette variable is referenced anywhere in the workspace outside the tokens block', () => {
    const offenders = sources(workspaceRoot, /\.(css|tsx?|html|mjs|js)$/)
      .filter((path) => path !== TOKENS_PATH && path !== SELF)
      .filter((path) => readFileSync(path, 'utf8').includes(TIER_1_PREFIX));
    expect(offenders).toEqual([]);
  });

  it('the base stylesheet names no colour of its own', () => {
    const base = readFileSync(join(appRoot, 'app', 'globals.css'), 'utf8');
    expect(base.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('the token layer cannot shadow Tailwind, and cannot dangle', () => {
  /**
   * The C0 review's blocking finding, turned into a test. `--radius-*` is
   * Tailwind 4's own theme namespace: declaring `--radius-sm|md|lg` on an
   * unlayered `:root` re-points every `rounded-*` utility in the app, with no
   * diff in any component to show for it. The app's own scale is `--r-*`.
   */
  it('declares no --radius-* of its own', () => {
    const shadowed = Object.keys(light).filter((name) => name.startsWith('--radius-'));
    expect(shadowed).toEqual([]);
    expect(Object.keys(theme).filter((name) => name.startsWith('--radius-'))).toEqual([]);
  });

  /**
   * The other half of the same failure mode: `accent-[var(--accent)]` survived
   * the rename because an arbitrary-value class compiles whatever it is given,
   * and `--accent` had quietly stopped existing. Every `var(--x)` in app source
   * must name something this file declares.
   */
  it('every var(--…) in app source names a token tokens.css declares', () => {
    const declared = new Set([
      ...Object.keys(light),
      ...Object.keys(darkExplicit),
      ...Object.keys(theme),
    ]);
    const dangling: string[] = [];
    for (const path of sources(appRoot, /\.(css|tsx?|html)$/)) {
      if (path === TOKENS_PATH || path === SELF) continue;
      // Comments are stripped first. `android.md` A2 writes
      // `var(--safe-area-inset-bottom)` inside prose in `capacitor.config.ts` and
      // in a test — in both cases to say that shared UI must NOT use it, because
      // those variables exist on Android native and nowhere else. Scanning raw
      // text made this guard fail on a comment warning against the exact thing
      // the guard exists to catch. Found when `claude/build-core` and
      // `claude/build-android` were merged; neither branch was wrong.
      const source = stripComments(readFileSync(path, 'utf8'));
      for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        const name = match[1];
        // `--viz-*` is the chart palette, declared by chart-tokens.tsx itself
        // and deliberately NOT merged into the UI tokens (C0 rule 3).
        if (name.startsWith('--viz-')) continue;
        if (!declared.has(name)) dangling.push(`${path}: var(${name})`);
      }
    }
    expect(dangling).toEqual([]);
  });

  /**
   * `scripts/fonts.ts` decides what `pnpm font:coverage` measures. If it is a
   * hand transcription of the stacks below, a stack edit here certifies a
   * coverage number for a stack the app no longer declares.
   */
  it('scripts/fonts.ts declares the same three stacks as tokens.css', async () => {
    const { STACKS } = (await import(
      /* @vite-ignore */ join(workspaceRoot, 'scripts', 'fonts.ts')
    )) as typeof import('../../../../../scripts/fonts');

    for (const stack of STACKS) {
      const value = light[stack.token];
      expect(value, `${stack.token} is not declared in tokens.css`).toBeDefined();
      const families = value
        .split(',')
        .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      expect(families, stack.token).toEqual([...stack.declared]);
      for (const family of stack.measurable) expect(families).toContain(family);
    }
  });
});

describe('no component hardcodes a colour', () => {
  it('components/ carries no raw hex outside the chart palette', () => {
    const offenders = sources(join(appRoot, 'components'), /\.tsx?$/)
      // The chart palette is a SEPARATE palette on purpose (C0 rule 3); its own
      // header explains why it may not be merged into the UI tokens.
      .filter((path) => !path.endsWith('chart-tokens.tsx'))
      .filter((path) =>
        /#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b/i.test(readFileSync(path, 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
