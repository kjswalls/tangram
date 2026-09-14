/**
 * What the committed Android project must say (`docs/plans/android.md` A1).
 *
 * **There is no CI in this repository** — no `.github/` directory, and no
 * sibling plan creates one (`wave-zero.md` §10 ruling 13, `android.md` R11) — so
 * every rule that wants enforcement is a unit test under `tests/unit/`, in the
 * pattern `tests/unit/deps.test.ts` already uses for repo-shape assertions.
 * A1's criterion 3 asks for exactly that over the SDK levels; the rest of this
 * file is the same argument applied to the other Gradle facts a phase downstream
 * silently depends on.
 *
 * Read `apps/app/android/**` as source, not as build output. Capacitor's native
 * directory is a tree you edit — Gradle config, manifest entries, the asset copy
 * — and treating it as generated means every edit is lost on the next
 * regeneration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import capacitorConfig from '@/capacitor.config';
import { appRoot } from '@/lib/server/roots';

const APP = appRoot(import.meta.dirname);
const ANDROID = resolve(APP, 'android');

const read = (relative: string) => readFileSync(resolve(ANDROID, relative), 'utf8');

/**
 * `key = 24` / `key 24` / `key "24"`, which Gradle spells all three ways.
 *
 * **Anchored to the start of a line and refusing a comment**, because the naive
 * form takes the *first* occurrence anywhere in the file. The mutation that
 * demonstrates it — run against a copy, not reasoned about — is a commented-out
 * declaration above the real one:
 *
 *     // applicationId "com.evil.old"
 *     applicationId "com.kjswalls.tangram"
 *
 * The naive regex returns `com.evil.old`; this one returns the declaration. A
 * comment that does not repeat the key is harmless either way, which is why the
 * example has to be this shape.
 */
function gradleValue(source: string, key: string): string | undefined {
  const match = new RegExp(`^(?!\\s*(?://|#))\\s*(?:ext\\.)?${key}\\b\\s*=?\\s*["']?([\\w.]+)["']?`, 'm').exec(source);
  return match?.[1];
}

/** How many times a key is *declared* (not mentioned) in a Gradle file. */
function gradleDeclarations(source: string, key: string): number {
  return source.match(new RegExp(`^(?!\\s*(?://|#))\\s*(?:ext\\.)?${key}\\b\\s*=?\\s*["']?[\\w.]`, 'gm'))?.length ?? 0;
}

describe('SDK levels (A1 criterion 3)', () => {
  const variables = read('variables.gradle');

  // 24/36/36 are Capacitor 8.5.2's own defaults — verified in the shipped
  // package, `@capacitor/android/capacitor/build.gradle`, rather than taken from
  // AUDIT 2's search snippet — and 36 is what Play requires for new apps and
  // updates since 31 August 2026, with an extension available to 1 November 2026
  // (developer.android.com/google/play/requirements/target-sdk, read 2026-09-14).
  it.each([
    ['minSdkVersion', '24'],
    ['compileSdkVersion', '36'],
    ['targetSdkVersion', '36'],
  ])('declares %s = %s', (key, expected) => {
    expect(gradleValue(variables, key)).toBe(expected);
    // Exactly one declaration: a second one further down would be the value
    // Gradle actually uses and the first is what this test would have read.
    expect(gradleDeclarations(variables, key), `${key} declared more than once`).toBe(1);
  });

  it('makes the app module read them rather than restating them', () => {
    // This is the half that stops a plugin's own defaults from quietly
    // overriding them: a module that hard-codes `minSdkVersion 21` passes a
    // check that only reads variables.gradle.
    const app = read('app/build.gradle');
    for (const key of ['compileSdkVersion', 'minSdkVersion', 'targetSdkVersion']) {
      expect(app, key).toMatch(new RegExp(`rootProject\\.ext\\.${key}`));
    }
    // And that no literal sits beside the reference. Asserting the reference
    // exists is not the same claim: `minSdkVersion 21` added on the line below
    // would win, and the loop above would still pass.
    //
    // One pattern, covering every spelling Gradle accepts — `minSdkVersion 21`,
    // `minSdk = 21`, `compileSdkVersion 33`, `targetSdk 34`, quoted or not. Two
    // narrower patterns were tried first and between them missed
    // `compileSdkVersion <n>` and every `= <n>` form.
    expect(app, 'a literal SDK level overrides the shared one').not.toMatch(
      /(?:min|target|compile)Sdk(?:Version)?\s*=?\s*["']?\d/,
    );
  });
});

describe('the Android Gradle Plugin version', () => {
  /**
   * **AGP must be 8.5.1 or higher, and this is a 16 KB page-size requirement,
   * not housekeeping.** Google's own words
   * (developer.android.com/guide/practices/page-sizes, read 2026-09-14):
   *
   *   "In AGP version 8.3 to 8.5, apps are 16 KB aligned by default. However,
   *    bundletool does not zipalign APKs by default. So, the app may appear to
   *    work, but when built from a bundle in Play, it won't install."
   *
   * That is the exact failure `android.md` R1's mitigation does not catch: A5
   * runs `zipalign` on a **debug APK** and A7's fallback runs it on a locally
   * built release APK, and on AGP 8.3–8.5 both are green while the APK Play
   * generates from the bundle is not installable. The version is the only thing
   * that closes it before a rejection does, so it is asserted here.
   */
  it('is at least 8.5.1', () => {
    const version = /com\.android\.tools\.build:gradle:([\d.]+)/.exec(read('build.gradle'))?.[1];
    expect(version, 'no AGP classpath in android/build.gradle').toBeDefined();
    const [major, minor, patch] = version!.split('.').map(Number);
    const ordinal = major * 1e6 + minor * 1e3 + patch;
    expect(ordinal, `AGP ${version} is below 8.5.1`).toBeGreaterThanOrEqual(8 * 1e6 + 5 * 1e3 + 1);
  });
});

describe('the application id', () => {
  /**
   * `applicationId` is the app's permanent identity in Play and can never change
   * after the first upload (`android.md` A6a). The CLI writes it out of
   * `capacitor.config.ts`'s `appId` at `cap add` / `cap sync`, so the two can
   * drift only by a hand edit — which is precisely the edit A6a warns about, and
   * `ios.md` I0 has already recorded the `appId` as **provisional**. If the
   * owner changes it, both of these move together or the stores name two
   * different products.
   */
  it('matches capacitor.config.ts, in both build.gradle and the namespace', () => {
    const app = read('app/build.gradle');
    expect(gradleValue(app, 'applicationId')).toBe(capacitorConfig.appId);
    expect(gradleValue(app, 'namespace')).toBe(capacitorConfig.appId);
  });

  it('is where the MainActivity package lives', () => {
    const packageDir = (capacitorConfig.appId as string).split('.').join('/');
    expect(() => read(`app/src/main/java/${packageDir}/MainActivity.java`)).not.toThrow();
  });
});

describe('the WebView floor stays advisory (A6)', () => {
  /**
   * **Capacitor 8.5.2 does have a built-in WebView version gate, and it blocks.**
   * `android.md` A6 says it does not, citing Capacitor issue #4884; the shipped
   * source disagrees. `@capacitor/android@8.5.2`
   * `capacitor/src/main/java/com/getcapacitor/Bridge.java`:
   *
   *   public static final int MINIMUM_ANDROID_WEBVIEW_VERSION = 55;
   *   public static final int DEFAULT_ANDROID_WEBVIEW_VERSION = 60;
   *   if (!this.isMinimumWebViewInstalled()) { webView.loadUrl(errorUrl); return; }
   *
   * and `CapConfig.java` reads `android.minWebViewVersion` from the config,
   * flooring it at 55. So raising that key to A6's comfort floor would replace
   * A6's banner with a wall — "a learner on a five-year-old phone should get a
   * working dictionary with a banner asking them to update Android System
   * WebView, not a wall" — which is the opposite of what A6 specifies. The
   * comfort floor belongs in app code; this key stays at its default.
   */
  it('does not raise android.minWebViewVersion', () => {
    expect(capacitorConfig.android?.minWebViewVersion).toBeUndefined();
  });
});

describe('the gitignore rules that keep large and secret files out (A1 criterion 8)', () => {
  const ignore = read('.gitignore');

  it('ignores the keystore and its properties file before A7 creates them', () => {
    // The template ships these commented out. A signing key committed once is
    // committed forever, so the ignore exists before the file does.
    for (const pattern of ['*.jks', '*.keystore', 'keystore.properties']) {
      expect(ignore.split('\n'), pattern).toContain(pattern);
    }
  });

  it('ignores the directory cap sync copies dist/ into', () => {
    expect(ignore).toContain('app/src/main/assets/public');
  });

  it('ignores a dictionary artifact anywhere under the asset root', () => {
    // `app/src/main/assets/public` covers the copy that goes where
    // @capacitor-community/sqlite actually looks (`public/assets/databases`).
    // These cover the one android.md A5 currently tells a builder to make, into
    // the asset ROOT, which that rule does not match. The failure is a 43 MB
    // binary in git history.
    for (const pattern of [
      'app/src/main/assets/**/*.sqlite',
      'app/src/main/assets/**/*.db',
      'app/src/main/assets/**/decomp.json',
    ]) {
      expect(ignore.split('\n'), pattern).toContain(pattern);
    }
  });

  it('ignores build output and the local SDK path', () => {
    for (const pattern of ['build/', '.gradle/', 'local.properties', '*.apk', '*.aab']) {
      expect(ignore.split('\n'), pattern).toContain(pattern);
    }
  });

  it('ignores the two Gradle files cap sync regenerates', () => {
    // `capacitor.settings.gradle` embeds `node_modules/.pnpm/<name>@<version>_
    // <peer-hash>/...` paths out of the installed tree. Committing it commits a
    // path that goes stale on any version or peer change, and makes `git status`
    // dirty after every sync. Capacitor's own template gitignore omits both;
    // under pnpm that omission is wrong. See the .gitignore for the full note.
    for (const pattern of ['capacitor.settings.gradle', 'app/capacitor.build.gradle']) {
      expect(ignore.split('\n'), pattern).toContain(pattern);
    }
  });
});

describe("Capacitor's example tests are gone, and must not come back", () => {
  /**
   * `cap add android` ships two of them, and **one is guaranteed red**:
   * `ExampleInstrumentedTest.useAppContext()` asserts
   * `assertEquals("com.getcapacitor.app", appContext.getPackageName())` against
   * a project whose `applicationId` is this app's. The other asserts that
   * 2 + 2 is 4.
   *
   * They are deleted rather than corrected. `android.md` §7 puts automated
   * device testing out of scope for v1 in terms — *"unit-tested adapters in the
   * container, a compile-only gate if A1 can install the SDK, and written
   * per-phase device checklists … say that out loud rather than implying
   * coverage that does not exist"* — and a corrected version of either would
   * assert nothing about this app while implying a native test story that has
   * not been built. A red that means nothing is worse than no test: the first
   * person to run `connectedAndroidTest` spends an afternoon on it.
   */
  it('ships no com.getcapacitor.myapp sources', () => {
    for (const dir of ['app/src/androidTest', 'app/src/test']) {
      expect(existsSync(resolve(ANDROID, dir)), `${dir} is back`).toBe(false);
    }
  });
});

describe('the build command is one command', () => {
  const rootScripts = (
    JSON.parse(readFileSync(resolve(APP, '..', '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('exists at the workspace root and does the whole sequence', () => {
    // A1 criterion 2: reproducible from a clean checkout by one documented
    // command sequence. The order is data, then the web build, then the sync —
    // A5 inserts its asset copy between the build and the sync.
    const sync = rootScripts['android:sync'];
    expect(sync).toBeDefined();
    // Presence first. `indexOf` returns -1 for a missing step, so an ordering
    // assertion alone is vacuously true for exactly the step whose loss matters
    // most: delete `data:ensure` and -1 < everything, green.
    for (const step of ['data:ensure', '-F app build', 'cap sync android']) {
      expect(sync, `android:sync no longer runs ${step}`).toContain(step);
    }
    expect(sync.indexOf('data:ensure')).toBeLessThan(sync.indexOf('-F app build'));
    expect(sync.indexOf('-F app build')).toBeLessThan(sync.indexOf('cap sync android'));
  });
});
