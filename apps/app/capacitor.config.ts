/**
 * The Capacitor configuration — the shared surface both mobile plans inherit
 * (`docs/plans/ios.md` I0 §2, `docs/plans/android.md` §2, `docs/plans/wave-zero.md` §11).
 *
 * **Location and `webDir` are one decision, not two, and the CLI decides it.**
 * `@capacitor/cli` 8.5.2 resolves *everything* from `process.cwd()` and never
 * from the config file's own directory: `dist/config.js` `loadConfig()` opens
 * with `const appRootDir = process.cwd()`, `loadExtConfig(appRootDir)` looks for
 * `capacitor.config.ts` in exactly that directory with **no upward walk**, and
 * both `webDirAbs = resolve(appRootDir, webDir)` and
 * `ios.platformDirAbs = resolve(rootDir, 'ios')` hang off the same value. So:
 *
 *   - `webDir: 'dist'` is correct **because the CLI is always run with cwd
 *     `apps/app/`**, which the `cap*` scripts in this package's `package.json`
 *     guarantee (`pnpm -F app cap:sync:ios`). `'apps/app/dist'` would resolve to
 *     `apps/app/apps/app/dist`.
 *   - Run the CLI from the workspace root and it finds no config at all, falls
 *     back to `webDir: 'www'` and an empty `appId`. That much **is** caught:
 *     `checkWebDir` (`@capacitor/cli` 8.5.2 `dist/common.js`) refuses a `webDir`
 *     that is missing or has no `index.html`, and `copy`/`sync` print
 *     `[error] Could not find the web assets directory: ./www` and stop. Run in
 *     this repo on 2026-09-14 to check, rather than assumed.
 *   - **What is not caught is drift between `webDir` and Vite's `build.outDir`
 *     while a stale build is still on disk.** `dist/` is gitignored and survives
 *     an `outDir` change, so a mismatch would find an `index.html` — last
 *     week's — and copy it happily. That is the gap
 *     `tests/unit/platform/capacitor-config.test.ts` covers, and it is a unit
 *     test because there is no CI (STACK §5.9).
 *   - `ios/` and `android/` are siblings of this file only as a *consequence* of
 *     that cwd rule — the CLI has an `ios.path` option and no sibling
 *     requirement. Keeping them siblings is what makes the one cwd rule enough.
 *
 * **The iOS deployment target is 17.2, and it is set in the Xcode project, not
 * here** (`ios/App/App.xcodeproj/project.pbxproj`, `IPHONEOS_DEPLOYMENT_TARGET`;
 * Capacitor's own floor is 15.0 — `Capacitor.podspec`, the SPM template's
 * `platforms: [.iOS(.v15)]`, and the CLI's `ios.minVersion`). Three CSS floors
 * bear on it (`ios.md` I0's floor table, STACK §6):
 *
 *   | Feature                                        | Safari | → iOS |
 *   |------------------------------------------------|--------|-------|
 *   | `ruby-align` / `ruby-overhang` / `ruby-position`| 18.2   | 18.2  |
 *   | CSS Custom Highlight API                       | 17.2   | 17.2  |
 *   | `user-select: none` excluded from copy         | 16.4   | 16.4  |
 *
 * The Safari→iOS mapping is the open question `ios.md` I0 flagged as
 * *"not established by any audit or by STACK"*. It is settled from Apple's own
 * release notes, read 2026-09-14:
 *
 *   - "Safari 18.2 is available for iOS 18.2, iPadOS 18.2, visionOS 2.2,
 *     macOS 15.2, macOS Sonoma, and macOS Ventura."
 *     https://developer.apple.com/documentation/safari-release-notes/safari-18_2-release-notes
 *   - "Safari 17.2 is available for iOS 17.2, iPadOS 17.2, macOS Sonoma,
 *     macOS Monterey, and macOS Ventura."
 *     https://developer.apple.com/documentation/safari-release-notes/safari-17_2-release-notes
 *   - "Safari 16.4 is available for macOS Big Sur, macOS Monterey, macOS
 *     Ventura, iPadOS 16.4, and iOS 16.4."
 *     https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes
 *
 * **`ios.md` I0 recommends the highest of the three — 18.2 — and 17.2 is what
 * ships. The reason is a constraint the plan could not have known**, found by
 * running the CLI: `cap sync` *derives* the SPM manifest's platform from this
 * build setting. `getMajoriOSVersion` (`@capacitor/cli` 8.5.2
 * `dist/ios/common.js`) takes the two characters after the first
 * `IPHONEOS_DEPLOYMENT_TARGET = ` and `dist/util/spm.js` interpolates them as
 * `platforms: [.iOS(.v${major})]` into a manifest whose header is
 * `// swift-tools-version: 5.9`. At 18.2 that emits `.iOS(.v18)`, and `.v18`
 * does not exist in PackageDescription 5.9 — the generated, unmodifiable
 * ("DO NOT MODIFY THIS FILE") manifest does not build, and re-syncing reproduces
 * it. `.v17` is the highest platform that version of PackageDescription has.
 *
 * So the target is set by the highest **functional** floor rather than the
 * highest floor: the CSS Custom Highlight API, at exactly 17.2, is what paints
 * the drag selection. What 17.2 gives up is the ruby row, and only on devices
 * between 17.2 and 18.1 — a current device has every feature regardless, since a
 * deployment target decides *which devices may install the app*, not what the
 * engine on a modern one supports. `core.md` C3 judges that row's practical risk
 * **cosmetic** in any case: `over` is the engine default for horizontal text, so
 * an engine that ignores the declaration lays it out the same way.
 *
 * Two ways back to 18.2 if the owner wants it, both with a real cost:
 * set `experimental.ios.spm.swiftToolsVersion` to `'6.0'` (the CLI's own
 * `declarations.d.ts` warns "Capacitor does not officially support Swift 6 yet.
 * Setting this property to 6.0 or higher may cause issues"), or re-add the
 * platform with `--packagemanager CocoaPods`, which has no `Package.swift` at
 * all. Neither could be tested in the container this was written in.
 *
 * **`-webkit-ruby-position` is still not emitted** — the question `core.md` C3
 * handed to this phase by name — but the reason is no longer "the target makes
 * it dead bytes", and C3 should know that. At an 18.2 target it would have been
 * unreachable code. At 17.2 there is a real band, iOS 17.2 to 18.1, where
 * unprefixed `ruby-position` is absent. The answer is unchanged anyway, because
 * the declaration in question is `over`, which is the engine's own default for
 * horizontal text: a device that ignores the property lays the ruby out the same
 * way, which is exactly why C3 calls the risk cosmetic. **If C3 ever declares a
 * non-default `ruby-position`, this question reopens for that band** — and that
 * is a `core.md` decision, not one to pre-empt here with a speculative prefix.
 *
 * **`appId` is provisional.** It is baked into the Xcode project at
 * `cap add ios` and can never change after the first App Store Connect upload
 * (`ios.md` I6). No document in this repo records a domain, so this is a
 * placeholder keyed to the owner's GitHub identity, not a decision this session
 * could make: change it here **and** in `ios/App/App.xcodeproj/project.pbxproj`
 * (`PRODUCT_BUNDLE_IDENTIFIER`) before I7's first upload. See `HANDOFF.md`.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kjswalls.tangram',
  appName: 'Tangram',
  webDir: 'dist',
};

export default config;
