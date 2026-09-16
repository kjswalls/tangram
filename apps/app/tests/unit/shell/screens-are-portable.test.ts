/**
 * A screen cannot tell which shell it is in (docs/plans/core.md C7).
 *
 * C7 calls this "the enforcement is the deliverable, not the two shells": if a
 * screen can reach the router or the shell, the two shells drift into two
 * designs and a screen stops working anywhere but its own route.
 *
 * C7 offers a choice — "an eslint `no-restricted-imports` rule … A unit test
 * walking the import graph is an acceptable substitute … one of the two must
 * exist". **Both exist here**, and that is not belt-and-braces for its own
 * sake: this build has twice shipped a config-shaped rule that matched nothing
 * while every gate stayed green (`wave-zero.md` §10a — the dictionary tracing
 * globs in W0, and the access gate's exact-string match). An eslint glob is
 * exactly that shape. The cases below cannot be silently turned off by a typo
 * in a `files:` pattern, and the last one asserts the eslint rule is still
 * declared for the right directory.
 *
 * **Two levels, and they are different rules.** The first three cases are the
 * *boundary*: no file in `components/screens/**` imports the router or the
 * shell, directly. The last-but-one is the *graph*, and it is deliberately not
 * a prohibition — C7's rule is about the screen boundary, and the components
 * below it may keep their real `<Link>`s, because a list is a page a learner
 * may want to open in a new tab. What the walk does is **name them**: it
 * follows every `@/…` and relative import reachable from a screen and asserts
 * the set of modules that reach the router is exactly the allowlist. A new one
 * fails, and has to be argued for in writing rather than discovered a year
 * later. An earlier draft of this file claimed to walk the graph and read only
 * the direct specifiers; the claim is now the code.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCREENS = join(appRoot, 'components', 'screens');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Every module specifier a file imports from, comments stripped. */
function imports(path: string): string[] {
  const source = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [
    ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1]);
}

/** `@/x` and `./x` to a file on disk, or null for a package. */
function resolveSpecifier(specifier: string, from: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(appRoot, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const screens = walk(SCREENS);

describe('components/screens/**', () => {
  it('is a real directory with real screens in it', () => {
    // Without this the whole file passes vacuously the day someone renames the
    // directory — which is the failure mode it exists to prevent.
    expect(screens.length).toBeGreaterThanOrEqual(4);
    const names = screens.map((path) => relative(SCREENS, path));
    expect(names).toEqual(expect.arrayContaining(['look-up.tsx', 'practice.tsx', 'library.tsx']));
  });

  it('imports nothing from the router', () => {
    for (const screen of screens) {
      const offenders = imports(screen).filter((specifier) => /^react-router/.test(specifier));
      expect(offenders, relative(appRoot, screen)).toEqual([]);
    }
  });

  it('imports nothing from components/shell', () => {
    for (const screen of screens) {
      const offenders = imports(screen).filter((specifier) =>
        /components\/shell\//.test(specifier),
      );
      expect(offenders, relative(appRoot, screen)).toEqual([]);
    }
  });

  it('gets its navigation handed down, as a destination rather than a path', () => {
    // The seam itself: a screen that navigates does it through this one module,
    // and a screen that hardcodes `/practice` has the route table memorised.
    const navigating = screens.filter(
      (screen) =>
        // …except the module that DEFINES it.
        !screen.endsWith('navigate.ts') && readFileSync(screen, 'utf8').includes('useScreenNavigate'),
    );
    expect(navigating.length).toBeGreaterThan(0);
    for (const screen of navigating) {
      expect(imports(screen), relative(appRoot, screen)).toContain(
        '@/components/screens/navigate',
      );
    }
  });

  /**
   * The walk. See the header: this names what is below the boundary rather than
   * forbidding it.
   */
  it('reaches the router from exactly one module below the boundary', () => {
    /**
     * `components/lists/list-card.tsx` renders a real `<Link>` to a list page,
     * on purpose: a list is a place a learner may want to open in a new tab,
     * and C7's rule is about the *screen* boundary. It also imports
     * `components/shell/nav` — for `listPath`, a pure string function with no
     * JSX in it. Both are deliberate and both are recorded in HANDOFF.md.
     *
     * Anything else appearing here is a screen that has quietly learned the
     * route table through a component, which is the drift this file exists to
     * catch.
     */
    const ALLOWED = ['components/lists/list-card.tsx'];

    const seen = new Set<string>();
    const reaching = new Set<string>();
    const visit = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      for (const specifier of imports(path)) {
        if (/^react-router/.test(specifier) || /components\/shell\//.test(specifier)) {
          reaching.add(relative(appRoot, path).replaceAll('\\', '/'));
        }
        const next = resolveSpecifier(specifier, path);
        if (next) visit(next);
      }
    };
    for (const screen of screens) visit(screen);

    // The walk actually went somewhere — without this the assertion below
    // passes against a resolver that resolves nothing.
    expect(seen.size).toBeGreaterThan(50);
    expect([...reaching].sort()).toEqual(ALLOWED);
  });

  it('…and the eslint rule that says the same thing is still pointed at it', () => {
    const config = readFileSync(join(appRoot, 'eslint.config.mjs'), 'utf8');
    const block = config.slice(config.indexOf("files: ['components/screens/"));
    expect(block, 'the C7 eslint block no longer targets components/screens').not.toBe('');
    expect(block).toContain("name: 'react-router'");
    expect(block).toContain('components/shell/*');
  });
});
