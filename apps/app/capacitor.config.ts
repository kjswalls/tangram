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

  /**
   * Plugin configuration — `android.md` A2's half of this file. I0 owns the
   * three keys above; A2's Files list claims "plugin configuration only".
   *
   * **`SystemBars` is Capacitor 8.5's own plugin and it is the whole of A2's
   * inset story.** `android.md` A2 was written against
   * `@capacitor-community/safe-area`, on the reading that a plugin would publish
   * inset values for the shell to read from CSS variables. Neither half survived
   * contact with the shipped code:
   *
   * - The community plugin publishes nothing. Its entire JS API is
   *   `setSystemBarsStyle` / `showSystemBars` / `hideSystemBars`; it is a
   *   *polyfill*, which pads the WebView below Chromium 140 and lets `env()`
   *   through above it.
   * - **Capacitor core already does exactly that**, in
   *   `@capacitor/android@8.5.2` `plugin/SystemBars.java`:
   *   `WEBVIEW_VERSION_WITH_SAFE_AREA_FIX = 140`, a `viewport-fit=cover` probe
   *   evaluated against the live document, `setPadding(0, 0, 0, keyboardVisible
   *   ? imeInsets.bottom : 0)` for the keyboard, and — in `css` mode —
   *   `--safe-area-inset-{top,right,bottom,left}` set on `documentElement`.
   *   Installing the community plugin on top of it would put two owners on one
   *   window, which is why that plugin's own README tells you to set
   *   `insetsHandling: 'disable'` first.
   *
   * So the Android dependency STACK §2.1 calls mandatory is **not installed**,
   * and A2 is configuration plus one module for the thing configuration cannot
   * do (`lib/platform/system-bars.ts`).
   */
  plugins: {
    SystemBars: {
      /**
       * **`'css'` is the shipped default, pinned rather than relied on**, so a
       * Capacitor upgrade that changes the default cannot change this app's
       * layout without a diff. `'native'` is the vendor's "recommended" and is
       * lighter — no `evaluateJavascript` on every inset change, keyboard shows
       * and hides included — and it would also be correct here.
       *
       * **What `'css'` adds is `--safe-area-inset-*` on `documentElement`, and
       * those variables exist on Android native and nowhere else.** An earlier
       * version of this comment had that backwards and offered them to
       * `core.md` as a cross-plan contract; writing
       * `var(--safe-area-inset-bottom)` in shared UI would resolve to nothing on
       * iOS and on the web, which is worse than the failure it was meant to
       * prevent. **Shared UI uses `env(safe-area-inset-*)`** — which is what
       * `core.md` C1's `TabBar` and `Sheet` already do, on every platform. The
       * variables are for reading a value in the WebView inspector, which is
       * what A2's device checklist does with them.
       *
       * `'disable'` is the one value that breaks the app on a phone: it hands
       * the insets back to code that does not exist.
       */
      insetsHandling: 'css',
      /**
       * We *know* the meta tag says `cover` — `index.html` sets it and
       * `tests/unit/pwa/manifest.test.ts` holds it there — and the plugin's
       * probe cannot run until the document commits. Telling it up front is
       * purely to stop the first paint laying out at the wrong inset and then
       * jumping. `tests/unit/platform/system-bars.test.ts` fails if this and the
       * meta tag ever disagree.
       */
      initialViewportFitValueHint: 'cover',
      /**
       * The initial icon contrast, and it is **not** `DEFAULT`.
       *
       * `DEFAULT` follows the *device's* dark mode. Inkstone is the default
       * theme on every device including a dark-preferring one — the ruling
       * relayed to this session and recorded in `HANDOFF.md`, since
       * **`wave-zero.md` carries no §10c**, and implemented in `core.md` C0's
       * `tokens.css` — so `DEFAULT` paints white icons over `#f8f4ec` for every
       * learner whose phone is in dark mode. `LIGHT` means "dark content on a
       * light background", which is the warm paper ground.
       *
       * This is the value at launch. `lib/platform/system-bars.ts` is what keeps
       * it right when the learner chooses the dark variant, and `core.md`'s
       * theme control is what calls it.
       */
      style: 'LIGHT',
    },
    /**
     * **`StatusBar` is a second owner of the same window, so it is configured to
     * agree rather than to race.**
     *
     * I0 pinned `@capacitor/status-bar` for `ios.md` I5 and the dependency set
     * is I0's, so A2 does not remove it. But it is **not** inert on Android:
     * `StatusBar.load()` calls `setStyle(config.getStyle())` on every launch,
     * that path is ungated (only `setBackgroundColor` is gated, and on the
     * *device's* API level rather than on `targetSdk`), and the config default
     * is `DEFAULT` — "based on the device appearance". So leaving it unset means
     * two plugins write the same `WindowInsetsControllerCompat` at launch and the
     * later one wins, which on a dark-mode phone is exactly the failure the
     * `SystemBars.style` above exists to prevent. Its `Style.Light` means the
     * same thing as `SystemBarsStyle.Light` — dark content for a light
     * background — so one value serves both.
     *
     * `lib/platform/system-bars.ts` sets both at runtime for the same reason:
     * `StatusBar.updateStyle()` re-applies its own remembered style on every
     * configuration change, so a rotation would otherwise undo a theme change
     * made through `SystemBars` alone.
     */
    StatusBar: {
      style: 'LIGHT',
    },
    /**
     * **`Keyboard` gets no configuration, and that is the configuration.**
     * `SystemBars.warnAboutUnsupportedConfigurationValues()` logs a warning when
     * `Keyboard.resizeOnFullScreen` is set alongside any non-`disable`
     * `insetsHandling`, because both would then resize for the keyboard. The
     * plugin is installed (I0 pinned it for `ios.md` I5) and is simply left
     * unconfigured here. A unit test holds that, because the symptom is a layout
     * that is wrong only while a keyboard is open on a device.
     */
  },
};

export default config;
