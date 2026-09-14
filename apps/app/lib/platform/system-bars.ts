/**
 * The status bar's and gesture bar's icon colour, on Android
 * (`docs/plans/android.md` A2, acceptance criterion 5).
 *
 * **Why this is code at all, when the insets are not.** A2's other half — the
 * safe-area insets and the keyboard — turned out to need no app code: Capacitor
 * 8.5's own `SystemBars` plugin handles it, and `capacitor.config.ts` records
 * the decision. Icon contrast is the part it cannot do for us, and the reason is
 * `wave-zero.md` §10c: **Inkstone, the warm paper palette, is the default on
 * every device, including a dark-preferring one.** So the system bars' own
 * `DEFAULT` style — *"based on the device appearance … if the device is using
 * Dark mode, the system bars content will be light"* — puts white icons over a
 * `#f8f4ec` page on any phone set to dark mode, which is the failure criterion 5
 * exists to catch. The config pins `LIGHT` for the default theme; this module is
 * what keeps it right when the learner picks the dark variant.
 *
 * **The naming is inverted and it is the vendor's, not ours.** `SystemBarsStyle`
 * describes the *content*, not the ground: `Light` means *"dark system bar
 * content on a light background"*. So an app ground of `light` takes
 * `SystemBarsStyle.Light`, and `dark` takes `Dark`. This module takes the
 * app's own vocabulary — which ground is on screen — so no caller has to hold
 * that inversion in their head.
 *
 * **Who calls it.** Whoever owns the theme switch, which is `core.md`'s: the
 * `data-theme` control C0 put on `/gallery` and whatever C7 or C9 gives the
 * learner. One line, on every theme change and once on start. It is a no-op off
 * Android and never throws, so a caller needs no platform branch of its own —
 * that branch lives here, which is the rule `lib/platform/native.ts` sets.
 * Recorded in `HANDOFF.md` so C7 calls this rather than writing a second one.
 *
 * **`@capacitor/core` is imported dynamically**, for the reason
 * `components/shell/hardware-back-button.tsx` gives: a static import would put
 * the bridge in the web bundle and install the `Capacitor` global in every
 * browser, for a plugin only Android has.
 *
 * **Not `@capacitor/status-bar`,** which I0 pinned for `ios.md` I5 and which is
 * still installed. On Android at `targetSdk` 36 that plugin's colour half is
 * inert by its own logic — `StatusBar.shouldSetStatusBarColor()` returns false
 * outright when the app targets 16 — and its `setOverlaysWebView()` drives the
 * deprecated `setSystemUiVisibility` decor flags, which is exactly the window
 * state `SystemBars` is managing. Two owners of one window is the bug. iOS is
 * unaffected and I5 keeps its choice; this is an Android note, and it is in
 * `HANDOFF.md` rather than acted on, because the dependency set is I0's.
 */
import { isAndroid } from '@/lib/platform/native';

/** Which ground the app is painting — not which colour the icons end up. */
export type AppGround = 'light' | 'dark';

/**
 * The vendor style for a given app ground. Exported for the unit test, which is
 * the only place the inversion can be pinned without a device.
 */
export function barStyleFor(ground: AppGround): 'LIGHT' | 'DARK' {
  // `Light` = dark content on a light background. See the header.
  return ground === 'dark' ? 'DARK' : 'LIGHT';
}

/**
 * Set both system bars' content style to suit the app's current ground.
 *
 * Resolves on every platform. Off Android it does nothing at all — not even the
 * dynamic import — so calling it from shared UI code is free.
 */
export async function applySystemBarsStyle(ground: AppGround): Promise<void> {
  if (!isAndroid()) return;

  try {
    const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
    const style = barStyleFor(ground) === 'DARK' ? SystemBarsStyle.Dark : SystemBarsStyle.Light;
    // No `bar`, which the plugin reads as "both".
    await SystemBars.setStyle({ style });
  } catch {
    // An unavailable plugin leaves the bars at whatever the theme gave them,
    // which is legible-by-default rather than wrong. Never a thrown error in a
    // theme switch.
  }
}
