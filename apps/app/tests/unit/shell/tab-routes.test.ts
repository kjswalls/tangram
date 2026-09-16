/**
 * Three tabs, and nothing left of the seven routes (docs/plans/core.md C7).
 *
 * Two of C7's criteria are statements about files rather than about a running
 * browser — "the old seven-route nav is gone" and "no spec references a removed
 * route" — and there is no CI here, so they are unit tests or they are nothing
 * (CLAUDE.md).
 *
 * The second one has a trap in it. **There are deliberately no redirects from
 * the old paths**: with no users and no bookmarks, a redirect would make the
 * criterion untestable, because a stale `page.goto('/review')` would keep
 * passing against one. So the e2e suite is greppped instead, and a spec that
 * still navigates to a removed route fails here rather than mysteriously
 * landing on the not-found screen three months from now.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TABS, TAB_PATHS, listPath, tabForPath } from '@/components/shell/nav';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The five paths the three tabs replaced. `/` and `/read` survive. */
const REMOVED = ['/lookup', '/review', '/lists', '/stats', '/settings'] as const;

/** A file's source with comments stripped. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('the three tabs', () => {
  it('are Look up, Practice, Library, in that order', () => {
    // §1 states the order and the placement; `ios.md` I5 and `android.md` A2
    // both depend on it rather than guessing.
    expect(TABS.map((tab) => tab.key)).toEqual(['lookup', 'practice', 'library']);
    expect(TABS.map((tab) => tab.label)).toEqual(['Look up', 'Practice', 'Library']);
  });

  it('carry §1’s accents by meaning, not one colour for all three', () => {
    expect(TABS.map((tab) => tab.accent)).toEqual(['lookup', 'practice', 'neutral']);
  });

  it('mark their own sub-paths, so a text or a list keeps its tab', () => {
    expect(tabForPath('/')).toBe('lookup');
    expect(tabForPath(TAB_PATHS.texts)).toBe('lookup');
    expect(tabForPath(TAB_PATHS.practice)).toBe('practice');
    expect(tabForPath(TAB_PATHS.library)).toBe('library');
    expect(tabForPath(listPath('abc'))).toBe('library');
    // The gallery and the drag-select harness are outside the shell entirely.
    expect(tabForPath('/gallery')).toBeUndefined();
    expect(tabForPath('/span-select')).toBeUndefined();
  });

  it('do not let `/` swallow everything, which a prefix match would', () => {
    // `'/'` is exact and everything else is a prefix — the same rule the seven
    // routes' `nav-link.tsx` used, and the reason `/nope` marks no tab at all.
    expect(tabForPath('/nope')).toBeUndefined();
  });
});

describe('the seven routes are gone', () => {
  it('the route table names each tab exactly once, and no removed path', () => {
    const routes = readFileSync(join(appRoot, 'src', 'routes.tsx'), 'utf8');
    for (const path of REMOVED) {
      expect(routes, `src/routes.tsx still routes ${path}`).not.toContain(`'${path.slice(1)}'`);
    }
    // …and it reads the paths from the nav rather than carrying its own copy,
    // which is what stops the bar and the router disagreeing about where a tab
    // is (the job `NAV_ITEMS` did for the seven).
    expect(routes).toContain('TAB_PATHS');
  });

  it('no route module is left over for a removed destination', () => {
    const modules = readdirSync(join(appRoot, 'src', 'routes'));
    for (const name of ['today.tsx', 'lookup.tsx', 'review.tsx', 'read.tsx', 'lists.tsx', 'stats.tsx', 'settings.tsx']) {
      expect(modules, `src/routes/${name} outlived its route`).not.toContain(name);
    }
  });

  it('no spec navigates to a removed route', () => {
    const specs = walk(join(appRoot, 'tests', 'e2e'));
    const offenders: string[] = [];
    for (const spec of specs) {
      // Comments stripped: every spec's header prose names the route it grew
      // out of, and that history is worth keeping — what must not survive is a
      // navigation.
      // `\/library\/lists\/…` contains the substring `\/lists`, so the new
      // path is taken out before the old ones are looked for. Without this the
      // check reports the very migration it is policing.
      const source = code(spec).replaceAll('\\/library\\/lists', '');
      for (const path of REMOVED) {
        // `goto('/lists')` and `goto('/lists/…')` both count; `/library/lists/x`
        // does not, which is why the match is anchored on the quote.
        if (new RegExp(`['\`]${path}(['\`/?#])`).test(source)) {
          offenders.push(`${relative(appRoot, spec)} → ${path}`);
        }
        // …and the other half: `toHaveURL(/\/lists$/)` is an assertion ABOUT a
        // removed route that no `goto` would reveal. Inside a regex literal the
        // slash is escaped, so `\/lists` is the shape to look for.
        if (source.includes(`\\${path}`)) {
          offenders.push(`${relative(appRoot, spec)} → asserts URL ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * C7's suite-migration criterion, "with a number in it".
   *
   * **The plan's number is stale and that is the finding, not a failure.** C7
   * was written against 29 files, of which 22 navigated by path; C1–C6 had
   * already added their own specs by the time C7 ran (44/37/35), and C8 added
   * three more. The number here is the one the repository actually has, and
   * what matters is that it is *asserted*: a migration whose scope is "the
   * specs I happened to open" is how three of them quietly stop running. A
   * phase that adds a spec updates this line, deliberately. Recorded in
   * HANDOFF.md.
   */
  it('every spec in the suite is accounted for, by count', () => {
    const files = walk(join(appRoot, 'tests', 'e2e'));
    const specs = files.filter((path) => path.endsWith('.spec.ts'));
    const navigating = files.filter((path) => code(path).includes('page.goto('));
    // Raised when `web.md` W2–W4 and `data.md` D4 merged in alongside C8: they
    // brought routes.spec, access-gate, spa-fallback and dict-wasm with them.
    // The number is the repository's, not the plan's — see the note above.
    expect({ files: files.length, specs: specs.length, navigating: navigating.length }).toEqual({
      files: 48,
      specs: 41,
      navigating: 40,
    });
  });

  it('every path a spec navigates to is a tab, or below one', () => {
    // The other half of the criterion: "either navigate to a tab or reach their
    // screen through one". A `goto` is the only way a spec can enter the app,
    // so every literal one of them is collected and checked against the tab
    // model itself rather than against a list kept by hand.
    // `/dict-wasm` is `data.md` D4's OPFS harness and joins `/gallery` (C1) and
    // `/span-select` (C5a) as a dev-only route reached by spread, outside the
    // tab shell by construction. `/no/such/route` is `web.md` W2's 404 case: a
    // path that is deliberately not a route is the one thing this check must
    // not treat as a stale one.
    const outsideTheShell = ['/gallery', '/span-select', '/dict-wasm', '/no/such/route'];
    const offenders: string[] = [];
    for (const spec of walk(join(appRoot, 'tests', 'e2e'))) {
      for (const match of code(spec).matchAll(/goto\(\s*[`'"]([^`'"]*)[`'"]/g)) {
        const target = match[1];
        // An absolute URL is a spec serving its own build (the gallery-guard
        // spec); the path after the origin is what it asks for.
        const path = target.startsWith('http')
          ? new URL(target.replace(/\$\{[^}]*\}/g, '0')).pathname
          : target.split('?')[0].split('#')[0];
        if (outsideTheShell.includes(path)) continue;
        // A list id is interpolated, so the *shape* is what is checked.
        const concrete = path.replace(/\$\{[^}]*\}/g, 'x');
        if (tabForPath(concrete) === undefined) {
          offenders.push(`${relative(appRoot, spec)} → ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing in the app links to one either', () => {
    const offenders: string[] = [];
    for (const dir of ['components', 'src', 'app', 'lib']) {
      for (const file of walk(join(appRoot, dir))) {
        const source = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        for (const path of REMOVED) {
          if (new RegExp(`to=["'\`]${path}["'\`]|navigate\\(['\`]${path}['\`]\\)`).test(source)) {
            offenders.push(`${relative(appRoot, file)} → ${path}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
