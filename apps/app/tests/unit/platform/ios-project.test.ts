/**
 * The generated Xcode project's invariants (`docs/plans/ios.md` I1).
 *
 * Every phase of `ios.md` after this one ends in a **manual device checklist**,
 * by decision (I1: "automated tests stay web-only"). That decision is about the
 * running app; it is not a reason to leave the project *file* unguarded, and
 * three of the things most likely to go wrong here are plain text in a file this
 * container can read:
 *
 *  - **Xcode rewrites `project.pbxproj` whenever it feels like it.** "Update to
 *    recommended settings" is one click and it touches deployment targets. The
 *    17.2 target is not cosmetic: it is the CSS Custom Highlight API's floor,
 *    which is what paints the drag selection, and it is also the highest `.vN`
 *    the generated `Package.swift`'s tools version can express — so the number
 *    is load-bearing in two directions at once (`capacitor.config.ts`'s header).
 *  - **The bundle identifier can never change after the first App Store Connect
 *    upload**, and it lives in two files that are written from a third.
 *  - **UIScene is a future-dated, launch-breaking requirement** (`ios.md` R10:
 *    the iOS 27 SDK makes it mandatory; apps without it fail to launch). R10
 *    calls it a risk of *drift* and asks for the evidence to be re-read after
 *    any Capacitor or Xcode upgrade. A test re-reads it on every run.
 *
 * None of this proves the app builds. Nothing in this container can. It proves
 * the project has not silently drifted from what I1 recorded.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import capacitorConfig from '@/capacitor.config';
import { appRoot } from '@/lib/server/roots';

const APP = appRoot(import.meta.dirname);
const IOS = resolve(APP, 'ios');
const PBXPROJ = resolve(IOS, 'App/App.xcodeproj/project.pbxproj');
const INFO_PLIST = resolve(IOS, 'App/App/Info.plist');
const PACKAGE_SWIFT = resolve(IOS, 'App/CapApp-SPM/Package.swift');

/**
 * The floor: the CSS Custom Highlight API, which paints the drag selection.
 * `capacitor.config.ts`'s header carries the full reasoning, including why it is
 * not the 18.2 `ios.md` I0 recommends.
 */
const DEPLOYMENT_TARGET = '17.2';

/**
 * The highest `.vN` each PackageDescription version knows. `cap sync` derives
 * `Package.swift`'s `platforms:` from `IPHONEOS_DEPLOYMENT_TARGET` but leaves
 * the tools version alone, so the two can be made inconsistent by editing one
 * build setting — and the result is a manifest that cannot resolve, in a file
 * headed "DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands".
 */
const HIGHEST_PLATFORM_FOR_TOOLS = new Map([
  ['5.9', 17],
  ['5.10', 17],
  ['6.0', 18],
  ['6.1', 18],
]);

describe('the generated iOS project', () => {
  it('is committed, and its generated output is not', () => {
    for (const path of [PBXPROJ, INFO_PLIST, PACKAGE_SWIFT]) {
      expect(existsSync(path), path).toBe(true);
    }

    // `cap copy` writes the web build into the native tree on every sync. The
    // template's own ios/.gitignore excludes it; this asserts that it still
    // does, because a committed `public/` is a phone shipping last week's build.
    // Asked of git rather than of the .gitignore text, so a rule that is present
    // but not matching still fails.
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', resolve(IOS, path)], { cwd: APP, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };

    for (const generated of ['App/App/public', 'App/App/capacitor.config.json', 'App/App/config.xml']) {
      expect(ignored(generated), `${generated} must be gitignored`).toBe(true);
    }
    // The negative control: without it, an `ignored()` that always returned
    // true would pass the three assertions above.
    for (const committed of ['App/App/Info.plist', 'App/App/SceneDelegate.swift', 'App/CapApp-SPM/Package.swift']) {
      expect(ignored(committed), `${committed} must be committed`).toBe(false);
    }
  });

  it('carries the 17.2 deployment target in every build configuration', () => {
    const pbxproj = readFileSync(PBXPROJ, 'utf8');
    const targets = [...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map((m) => m[1]);

    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set([DEPLOYMENT_TARGET]));
  });

  it('carries the appId from capacitor.config.ts as the bundle identifier', () => {
    const pbxproj = readFileSync(PBXPROJ, 'utf8');
    const ids = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1].trim());

    expect(ids.length).toBeGreaterThan(0);
    expect(
      new Set(ids),
      // The remedy matters as much as the failure here, because the obvious one
      // does not work: `editProjectSettingsIOS` — the only code in the CLI that
      // writes PRODUCT_BUNDLE_IDENTIFIER — is called from `cap add` and from
      // nowhere else (`@capacitor/cli` 8.5.2 `dist/tasks/add.js`). A sync will
      // NOT fix this, and the identifier can never change after the first App
      // Store Connect upload.
      'the Xcode project and capacitor.config.ts disagree on the bundle identifier. `cap sync` will not ' +
        'reconcile them: edit PRODUCT_BUNDLE_IDENTIFIER in project.pbxproj (and CFBundleDisplayName in ' +
        'Info.plist) by hand, or delete ios/ and re-run `pnpm -F app cap add ios`.',
    ).toEqual(new Set([capacitorConfig.appId]));
  });

  it('adopts UIScene — the scene manifest and the delegate the iOS 27 SDK will require', () => {
    const plist = readFileSync(INFO_PLIST, 'utf8');
    expect(plist).toContain('<key>UIApplicationSceneManifest</key>');
    expect(plist).toContain('<key>UISceneConfigurations</key>');
    expect(plist).toContain('<key>UIWindowSceneSessionRoleApplication</key>');
    expect(plist).toContain('$(PRODUCT_MODULE_NAME).SceneDelegate');

    const sceneDelegate = readFileSync(resolve(IOS, 'App/App/SceneDelegate.swift'), 'utf8');
    expect(sceneDelegate).toContain('UIWindowSceneDelegate');
    expect(sceneDelegate).toContain('willConnectTo');

    const appDelegate = readFileSync(resolve(IOS, 'App/App/AppDelegate.swift'), 'utf8');
    expect(appDelegate).toContain('configurationForConnecting');
  });

  it('has a Package.swift whose platform agrees with the target and with its own tools version', () => {
    /**
     * Both halves of this bit the first time. `cap sync` writes
     * `platforms: [.iOS(.v${major})]` from the pbxproj's deployment target
     * (`getMajoriOSVersion`, which literally takes two characters) but leaves
     * `// swift-tools-version:` at its default `5.9`. So raising the target to
     * 18.2 produced `.iOS(.v18)` under tools 5.9 — a platform PackageDescription
     * 5.9 does not have, in a file that says DO NOT MODIFY and is regenerated
     * identically on every sync.
     */
    const manifest = readFileSync(PACKAGE_SWIFT, 'utf8');

    const platform = manifest.match(/platforms:\s*\[\.iOS\(\.v(\d+)\)\]/);
    expect(platform, 'Package.swift declares no iOS platform').not.toBeNull();
    const declared = Number(platform![1]);

    // Derived from the build setting, so they must agree.
    expect(declared).toBe(Number(DEPLOYMENT_TARGET.split('.')[0]));

    const tools = manifest.match(/swift-tools-version:\s*([\d.]+)/);
    expect(tools, 'Package.swift declares no swift-tools-version').not.toBeNull();
    const highest = HIGHEST_PLATFORM_FOR_TOOLS.get(tools![1]);
    expect(
      highest,
      `swift-tools-version ${tools![1]} is not in this test's table — check which .vN PackageDescription ` +
        `${tools![1]} defines before trusting the deployment target`,
    ).toBeDefined();
    expect(
      declared,
      `.v${declared} does not exist in PackageDescription ${tools![1]}. Either lower ` +
        `IPHONEOS_DEPLOYMENT_TARGET or raise experimental.ios.spm.swiftToolsVersion in capacitor.config.ts, ` +
        `then re-run \`pnpm -F app cap:sync:ios\`.`,
    ).toBeLessThanOrEqual(highest as number);
  });

  it('has a Package.swift whose every local path still exists', () => {
    /**
     * `cap sync` writes one `.package(path:)` per plugin, and under pnpm the
     * path goes through the store: `../../../../../node_modules/.pnpm/
     * @capacitor+keyboard@8.0.5_@capacitor+core@8.5.2/node_modules/...`. That
     * directory name encodes the plugin's version *and* its peer hash, so any
     * dependency bump invalidates every line of this file. `cap sync`
     * regenerates it and the file says "DO NOT MODIFY - managed by Capacitor
     * CLI commands" — so the failure mode is a committed manifest that has gone
     * stale, and on a Mac that is an Xcode package-resolution error with no
     * obvious cause. Here it is one failing assertion naming the path.
     */
    const manifest = readFileSync(PACKAGE_SWIFT, 'utf8');
    const paths = [...manifest.matchAll(/\.package\(name: "[^"]+", path: "([^"]+)"\)/g)].map((m) => m[1]);

    expect(paths.length).toBeGreaterThan(0);
    const missing = paths.filter((path) => !existsSync(resolve(dirname(PACKAGE_SWIFT), path)));
    expect(missing, 'run `pnpm -F app cap:sync:ios` to regenerate Package.swift').toEqual([]);
  });

  it('includes every plugin package.json declares, and nothing it does not', () => {
    // The other half of the same drift: a plugin added to package.json but never
    // synced is absent from the native build, and the app calls a plugin that is
    // not there — which fails at runtime on a device, not here.
    const manifest = readFileSync(PACKAGE_SWIFT, 'utf8');
    const pkg = JSON.parse(readFileSync(resolve(APP, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const plugins = Object.keys(pkg.dependencies).filter(
      (name) => name.startsWith('@capacitor/') || name.startsWith('@capacitor-community/'),
    );
    // @capacitor/core is the bridge, not a plugin: it has no native package of
    // its own in the app's Package.swift (Capacitor comes from capacitor-swift-pm).
    for (const plugin of plugins.filter((name) => name !== '@capacitor/core')) {
      expect(manifest, `${plugin} is in dependencies but not in Package.swift`).toContain(plugin);
    }
    expect(manifest).toContain('capacitor-swift-pm');
  });
});
