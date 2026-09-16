/**
 * Which of §1's accents a destination owns, if any (docs/plans/core.md C1/C7).
 *
 * Its own module rather than a type inside `tab-bar.tsx` for one mechanical
 * reason: `components/shell/nav.ts` needs it, and the workspace-root TypeScript
 * project — which typechecks `scripts/**`, and `scripts/smoke.ts` imports
 * `nav.ts` — has no `--jsx`, so a type imported out of a `.tsx` file fails
 * there while every app-level gate stays green. Exactly the shape of failure
 * `wave-zero.md` §10a is about.
 *
 * **The active tint is the destination's own, not one colour for all three.**
 * §1 assigns the accents by meaning — jade is Look up, vermillion is Practice
 * and the single primary action, gold is "new" — so a bar that painted whatever
 * tab was active in vermillion would put a permanent vermillion-tinted region
 * in the chrome of every screen, next to the one vermillion action that screen
 * is allowed. `neutral` is ink on a `--border` pill and is the right answer for
 * a destination with no colour of its own.
 */
export type TabAccent = 'neutral' | 'lookup' | 'practice' | 'new';
