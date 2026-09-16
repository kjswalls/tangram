'use client';

/**
 * How a screen asks to go somewhere (docs/plans/core.md C7).
 *
 * **The enforcement is the deliverable, not the two shells.** C7's rule is that
 * a screen cannot tell which shell it is in: screens live in
 * `components/screens/**`, take everything they need as props or from stores,
 * and import nothing from `components/shell/**` and nothing from the router.
 * Without it the two shells drift into two designs, and a screen rendered
 * anywhere but its own route stops working.
 *
 * So navigation is **handed down**, and it is handed down as a *destination*
 * rather than a path. A path is a router fact wearing a string's clothes: a
 * screen that says `'/library/lists/42'` has the route table memorised and
 * breaks silently when it changes, which is exactly what C7 is rearranging.
 * A screen says `{ tab: 'library', list: id }`; the shell knows what that means.
 *
 * This module is under `components/screens/` rather than `components/shell/`
 * on purpose: the shell may import from screens, never the other way round.
 *
 * `eslint.config.mjs` forbids the two import families inside
 * `components/screens/**`, and `tests/unit/shell/screens-are-portable.test.ts`
 * walks the import graph — because an eslint glob that matches nothing is a
 * rule that looks enforced and is not (`wave-zero.md` §10a, twice).
 */
import { createContext, useContext } from 'react';

/**
 * The three destinations, named here rather than in `components/shell/nav.ts`.
 *
 * A screen has to be able to say where it wants to go, and it may not import
 * the shell — so the *names* live on the screens' side of the seam and
 * `nav.ts` imports them. The shell knows what a tab looks like and where it
 * lives; the screens know only that there are three of them.
 */
export type TabKey = 'lookup' | 'practice' | 'library';

export type ScreenDestination =
  /** A tab's own screen. */
  | { tab: TabKey }
  /** The Look up tab's pasted-texts view. */
  | { tab: 'lookup'; view: 'texts' }
  /** One list, inside Library. */
  | { tab: 'library'; list: string };

export type ScreenNavigate = (to: ScreenDestination) => void;

/**
 * The default does nothing, deliberately.
 *
 * A screen rendered with no shell around it — a unit test, the gallery — must
 * render rather than throw; what it must not do is navigate somewhere the
 * caller never provided a way to go.
 */
const ScreenNavigateContext = createContext<ScreenNavigate>(() => undefined);

export const ScreenNavigateProvider = ScreenNavigateContext.Provider;

export function useScreenNavigate(): ScreenNavigate {
  return useContext(ScreenNavigateContext);
}
