/**
 * Am I running inside a native shell, and which one? (`docs/plans/ios.md` I0.)
 *
 * One module, so that nothing anywhere else reads `window.Capacitor` — the
 * grep in I0's acceptance criterion 3 is the rule. Everything that branches on
 * native imports from here: the service-worker gate
 * (`components/pwa/register-sw.tsx`), the API base (`web.md` W4), the
 * `DictStore` implementation (`data.md` D5a), the TTS adapter (`ios.md` I4 /
 * `android.md` A4).
 *
 * ## Why this reads the global instead of importing `@capacitor/core`
 *
 * Three reasons, and the first two are load-bearing:
 *
 * 1. **Importing `@capacitor/core` has a side effect: it installs the global.**
 *    Its last statement is `initCapacitorGlobal(globalThis)`, i.e.
 *    `win.Capacitor = createCapacitor(win)` — unconditionally, in any runtime,
 *    including Node and vitest. A module that every layer imports should not
 *    decide, as a side effect, that a global now exists.
 * 2. **This must stay importable under Node and jsdom with no Capacitor runtime
 *    present** (I0 criterion 3), because the unit suite runs in both and
 *    `scripts/` runs under plain Node.
 * 3. There is nothing to gain. `createCapacitor` merges over whatever the native
 *    bridge already put on the global (`const cap = win.Capacitor || {}`), so
 *    importing it adds no information about the platform that the global does
 *    not already carry.
 *
 * ## Why it is `isNativePlatform()` and not "does a `Capacitor` global exist"
 *
 * Because there is **one build for three platforms**, and the moment any module
 * in the bundle imports `@capacitor/core` — which it will, the first time a
 * plugin is called — the global exists in the *web* build too. A presence test
 * would then report the web PWA as native and switch its service worker off.
 * `register-sw.tsx`'s header already spells this out; this module is where the
 * answer lives now.
 *
 * The chain below is ordered by how much it is trusted, not by convenience:
 *
 * - `Capacitor.isNativePlatform()` / `Capacitor.getPlatform()` — defined by both
 *   producers of the global. `@capacitor/core` computes them as
 *   `getPlatform() !== 'web'` over `getPlatformId(win)`, and the bridge iOS and
 *   Android inject into the WebView at document start
 *   (`@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js`) defines the
 *   same two functions before any app code runs. This is the normal path on
 *   every platform.
 * - `platform` / `isNative` as plain properties — the shape a *very* old or
 *   partially-initialised bridge leaves behind. Kept as a fallback because the
 *   cost is four lines and the failure it covers (a native app that thinks it is
 *   the web, registers a service worker, and serves a previous build's shell
 *   after an app update) is invisible until someone updates the app.
 * - Otherwise `'web'`. A `Capacitor` global that answers none of the four
 *   questions is **not** treated as native: see the presence-test trap above.
 *
 * Nothing is memoised. The bridge is installed before app code on native and
 * never changes afterwards, so caching would buy one property read and cost the
 * ability to fake it per test.
 */

/** The platforms this app is built for. `'web'` covers the PWA and the browser. */
export type Platform = 'ios' | 'android' | 'web';

/** The two that are a native shell. */
export type NativePlatform = Exclude<Platform, 'web'>;

/**
 * The subset of the Capacitor global this module will touch. Every member is
 * optional: the global has two independent producers (the injected native
 * bridge and `@capacitor/core`) and this module must not assume either ran.
 */
interface CapacitorGlobal {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
  platform?: string;
  isNative?: boolean;
}

function bridge(): CapacitorGlobal | undefined {
  return (globalThis as typeof globalThis & { Capacitor?: CapacitorGlobal }).Capacitor;
}

function isPlatform(value: unknown): value is Platform {
  return value === 'ios' || value === 'android' || value === 'web';
}

/**
 * Which platform this code is running on: `'ios'`, `'android'` or `'web'`.
 *
 * An unrecognised platform id from a future bridge reports as `'web'` rather
 * than being passed through, so that callers only ever switch on three values
 * and the type is the truth.
 *
 * **That makes this disagree with `isNativePlatform()` for an unknown native
 * platform, deliberately.** A shell reporting `'electron'` is native — so the
 * service worker must not register — while the only implementation this build
 * *has* for it is the web one. Each function gives its own callers the answer
 * that degrades safely, and the pair is pinned by a unit test so the difference
 * is a decision rather than a bug someone later "fixes".
 */
export function getPlatform(): Platform {
  const cap = bridge();
  if (!cap) return 'web';

  if (typeof cap.getPlatform === 'function') {
    const reported = cap.getPlatform();
    if (isPlatform(reported)) return reported;
    // A bridge reporting something else is a native shell this build does not
    // know. Treat it as web — the degraded path is the one that works anywhere.
    return 'web';
  }

  if (isPlatform(cap.platform)) return cap.platform;
  return 'web';
}

/**
 * Is this running inside a native shell?
 *
 * Not "is Capacitor loaded". See the header: on the web the global exists as
 * soon as anything imports `@capacitor/core`, and it answers `false` here.
 */
export function isNativePlatform(): boolean {
  const cap = bridge();
  if (!cap) return false;

  if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
  if (typeof cap.getPlatform === 'function') return cap.getPlatform() !== 'web';
  if (typeof cap.isNative === 'boolean') return cap.isNative;
  if (typeof cap.platform === 'string') return cap.platform !== 'web';
  return false;
}

/** Native iOS specifically — the WKWebView shell, not Safari and not the PWA. */
export function isIOS(): boolean {
  return getPlatform() === 'ios';
}

/** Native Android specifically — the Chromium WebView shell, not Chrome. */
export function isAndroid(): boolean {
  return getPlatform() === 'android';
}
