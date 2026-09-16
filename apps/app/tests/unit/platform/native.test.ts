/**
 * The platform seam (`docs/plans/ios.md` I0 criterion 3).
 *
 * Two of these cases are the reason the module exists rather than being three
 * lines at each call site:
 *
 *  - **`@capacitor/core` imported on the web.** One build ships to three
 *    platforms, so the `Capacitor` global exists in the *browser* bundle the
 *    moment anything imports the package — it installs it on import. A
 *    presence test would call the web PWA native and switch its service worker
 *    off. The faked global here is exactly the shape `createCapacitor()`
 *    produces on the web: present, and answering `false`.
 *  - **A bridge with no `isNativePlatform()`.** The injected native bridge and
 *    `@capacitor/core` are two independent producers of that global, so the
 *    fallbacks are not hypothetical.
 *
 * Everything runs under jsdom with no Capacitor runtime installed, which is the
 * other half of criterion 3.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getPlatform, isAndroid, isIOS, isNativePlatform } from '@/lib/platform/native';
import { appRoot } from '@/lib/server/roots';

type Fake = Record<string, unknown>;

function fakeBridge(cap: Fake | undefined): void {
  if (cap === undefined) {
    Reflect.deleteProperty(globalThis, 'Capacitor');
    return;
  }
  Object.defineProperty(globalThis, 'Capacitor', { configurable: true, value: cap });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'Capacitor');
});

describe('with no Capacitor runtime present', () => {
  it('is the web, and importing this module does not create the global', () => {
    expect('Capacitor' in globalThis).toBe(false);
    expect(getPlatform()).toBe('web');
    expect(isNativePlatform()).toBe(false);
    expect(isIOS()).toBe(false);
    expect(isAndroid()).toBe(false);
  });
});

describe('with @capacitor/core loaded in a browser', () => {
  it('reports web — a `Capacitor` global is not a native platform', () => {
    fakeBridge({ getPlatform: () => 'web', isNativePlatform: () => false, Plugins: {} });

    expect('Capacitor' in globalThis).toBe(true);
    expect(getPlatform()).toBe('web');
    expect(isNativePlatform()).toBe(false);
    expect(isIOS()).toBe(false);
  });
});

describe('inside a native shell', () => {
  it('reports ios', () => {
    fakeBridge({ getPlatform: () => 'ios', isNativePlatform: () => true });

    expect(getPlatform()).toBe('ios');
    expect(isNativePlatform()).toBe(true);
    expect(isIOS()).toBe(true);
    expect(isAndroid()).toBe(false);
  });

  it('reports android', () => {
    fakeBridge({ getPlatform: () => 'android', isNativePlatform: () => true });

    expect(getPlatform()).toBe('android');
    expect(isNativePlatform()).toBe(true);
    expect(isAndroid()).toBe(true);
    expect(isIOS()).toBe(false);
  });
});

describe('the fallbacks, for a bridge that answers less than the current one', () => {
  it('falls back from isNativePlatform() to getPlatform()', () => {
    fakeBridge({ getPlatform: () => 'ios' });

    expect(isNativePlatform()).toBe(true);
    expect(getPlatform()).toBe('ios');
  });

  it('falls back to the plain `platform` and `isNative` properties', () => {
    fakeBridge({ platform: 'ios', isNative: true });

    expect(getPlatform()).toBe('ios');
    expect(isNativePlatform()).toBe(true);
    expect(isIOS()).toBe(true);
  });

  it('a global answering none of the four questions is web, not native', () => {
    // The presence-test trap, pinned: an empty object is not evidence of a
    // native shell, and reading it as one turns the web PWA's worker off.
    fakeBridge({ Plugins: {} });

    expect(getPlatform()).toBe('web');
    expect(isNativePlatform()).toBe(false);
  });
});

describe('an unknown native platform', () => {
  it('is native, and uses the web implementation — the two disagree on purpose', () => {
    fakeBridge({ getPlatform: () => 'electron', isNativePlatform: () => true });

    // Native, so no service worker: the safe answer for that caller.
    expect(isNativePlatform()).toBe(true);
    // The only implementation this build has for it is the web one, and the
    // union type stays honest.
    expect(getPlatform()).toBe('web');
    expect(isIOS()).toBe(false);
    expect(isAndroid()).toBe(false);
  });
});

describe('the seam is the only reader of the bridge', () => {
  /**
   * ios.md I0 criterion 3 states this as a grep over `src`, `lib` and
   * `components`. Those are three of the app's **four** source directories:
   * `apps/app/app/` survived the Vite move and still holds live view components
   * (`components/screens/today.tsx`, `app/settings/settings-form.tsx`, both
   * imported by `src/routes/`) plus the API route contracts. So this walks
   * everything under `apps/app/` instead of a hand-written list, minus the
   * directories that are not app source — a fifth source directory cannot
   * appear unguarded, which a list would allow.
   *
   * What it forbids is narrow and deliberate: reading the `Capacitor`
   * **global**. Calling what this module exports is the point of the seam.
   * Importing `@capacitor/core` for something that is *not* platform detection
   * (`convertFileSrc`, `registerPlugin`) stays legal — `data.md` D5a needs it —
   * and the rule those callers are still held to is that the platform question
   * is answered here.
   */
  const APP = appRoot(import.meta.dirname);
  const SEAM = resolve(APP, 'lib/platform/native.ts');
  const NOT_APP_SOURCE = new Set(['node_modules', 'dist', 'tests', 'ios', 'android', 'public', '.git']);
  // `window.Capacitor`, `globalThis.Capacitor`, `(window as any).Capacitor`,
  // `self.Capacitor`, and the optional-chained forms of each.
  const READS_THE_GLOBAL = /\b(?:window|globalThis|self)\b[^\n;]{0,80}?\??\.\s*Capacitor\b/;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (NOT_APP_SOURCE.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(path));
      else if (/\.tsx?$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  it('walks every app source directory, not a hand-written three', () => {
    // The guard is worth exactly what its file list covers, so assert the list
    // is not quietly empty and that it reaches the directory the criterion's
    // own grep misses.
    const files = sourceFiles(APP).map((file) => relative(APP, file));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('app/settings/settings-form.tsx');
    expect(files).toContain('src/routes.tsx');
    expect(files).toContain('lib/platform/native.ts');
    expect(files.some((file) => file.startsWith('node_modules/'))).toBe(false);
  });

  it('finds no other module reading window.Capacitor', () => {
    const offenders = sourceFiles(APP)
      .filter((file) => file !== SEAM)
      .filter((file) => READS_THE_GLOBAL.test(readFileSync(file, 'utf8')))
      .map((file) => relative(APP, file));

    expect(offenders).toEqual([]);
  });

  it('would catch a reader if one appeared', () => {
    // Otherwise the assertion above passes just as well with a regex that
    // matches nothing, which is the shape of test this repo has been bitten by.
    for (const violation of [
      'const cap = (window as any).Capacitor;',
      'if (globalThis.Capacitor?.isNativePlatform()) return;',
      'const platform = window.Capacitor.getPlatform();',
      'const native = self.Capacitor !== undefined;',
    ]) {
      expect(READS_THE_GLOBAL.test(violation), violation).toBe(true);
    }
    for (const fine of [
      "import { isNativePlatform } from '@/lib/platform/native';",
      "import { Capacitor } from '@capacitor/core';",
      'const url = Capacitor.convertFileSrc(path);',
    ]) {
      expect(READS_THE_GLOBAL.test(fine), fine).toBe(false);
    }
  });
});

describe('re-reading the bridge', () => {
  it('is not memoised — the answer follows the global', () => {
    expect(getPlatform()).toBe('web');
    fakeBridge({ getPlatform: () => 'ios', isNativePlatform: () => true });
    expect(getPlatform()).toBe('ios');
    fakeBridge(undefined);
    expect(getPlatform()).toBe('web');
  });
});
