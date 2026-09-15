/**
 * The status bar's and gesture bar's icon colour, on Android
 * (`docs/plans/android.md` A2, acceptance criterion 5).
 *
 * **Why this is code at all, when the insets are not.** A2's other half — the
 * safe-area insets and the keyboard — turned out to need no app code: Capacitor
 * 8.5's own `SystemBars` plugin handles it, and `capacitor.config.ts` records
 * the decision. Icon contrast is the part it cannot do for us, and the reason is
 * the Inkstone ruling — relayed to this session and recorded in `HANDOFF.md`,
 * because **`wave-zero.md` carries no §10c**, and implemented in `core.md` C0's
 * `tokens.css`: **Inkstone, the warm paper palette, is the default on every
 * device, including a dark-preferring one.** So the system bars' own
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
 * ## `@capacitor/status-bar` is installed, and it is a *live* second owner
 *
 * I0 pinned it at 8.0.3 for `ios.md` I5. An earlier version of this comment said
 * it was inert on Android at `targetSdk` 36 — **that was wrong, and the mistake
 * is worth keeping visible because it is the kind that reads as reassuring.**
 * `StatusBar.shouldSetStatusBarColor()` branches on `Build.VERSION.SDK_INT`, the
 * **device's** API level, not on `targetSdk`; and it gates only
 * `setBackgroundColor`. `setStyle` is ungated, and `StatusBar.load()` calls it on
 * every launch with a config default of `DEFAULT` — *"the style is based on the
 * device appearance"*. So with both plugins installed and only one configured,
 * two things set the same `WindowInsetsControllerCompat` at launch and the later
 * one wins, which on a dark-mode phone is the exact failure `SystemBars`'s
 * `style: 'LIGHT'` was set to prevent. `StatusBar.updateStyle()` re-applies its
 * own `currentStyle` on every configuration change, so a rotation would undo a
 * runtime change made only through `SystemBars`.
 *
 * Removing the package is not this phase's call — the dependency set is I0's,
 * and `CLAUDE.md`'s rule is to write the need down and continue. What is this
 * phase's call is **plugin configuration**, which `android.md` A2's Files list
 * grants, so both are configured to `LIGHT` and this function sets both. They
 * agree instead of racing, and it costs one config key and four lines. The key
 * also fixes rotation: `setStyle` assigns `currentStyle` *before* resolving
 * `DEFAULT` against the device theme, so with the config set that field holds
 * `LIGHT` and `updateStyle()` re-applies the app's choice instead of the phone's.
 *
 * **What configuration cannot reach, and it is worth being exact about.**
 * `StatusBarPlugin.load()` constructs `StatusBar` at plugin registration, and
 * that constructor runs `setBackgroundColor(config.getBackgroundColor())`,
 * `setStyle(config.getStyle())` and
 * `setOverlaysWebView(config.isOverlaysWebView())` **with no JS call at all** —
 * so "nothing in the Android build may call this plugin" is not a mitigation,
 * it is a misunderstanding of when the plugin runs. Two of those three are
 * settled by config; the third is `overlaysWebView`, which defaults to `true`
 * and drives the deprecated `setSystemUiVisibility` decor flags plus a
 * transparent status-bar colour. Those flags are ignored on Android 15+ but are
 * live across API 24–34, which `minSdk` 24 admits. **Whether that fights
 * `SystemBars` on such a device is a hardware question this container cannot
 * answer**, so it is not guessed at here: it is an item on A2's device
 * checklist and a note to `ios.md` I0 in `HANDOFF.md`, whose dependency-set call
 * it is. The only complete fix is excluding the package from the Android build.
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

  const wanted = barStyleFor(ground);

  try {
    const { SystemBars, SystemBarsStyle } = await import('@capacitor/core');
    // No `bar`, which the plugin reads as "both".
    await SystemBars.setStyle({ style: wanted === 'DARK' ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
  } catch {
    // An unavailable plugin leaves the bars at whatever the theme gave them,
    // which is legible-by-default rather than wrong. Never a thrown error in a
    // theme switch.
  }

  try {
    // The second owner. Not belt and braces: `StatusBar` re-applies its own
    // remembered style on every configuration change, so without this a rotation
    // in the dark variant would snap the bars back to the launch value.
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: wanted === 'DARK' ? Style.Dark : Style.Light });
  } catch {
    // Same reasoning. If I5 ever removes the package this becomes a no-op.
  }
}
