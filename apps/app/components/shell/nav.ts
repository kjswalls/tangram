/**
 * The three tabs (docs/plans/core.md C7; product-decisions §1).
 *
 * **Seven routes became three destinations.** Today, Lookup, Review, Read,
 * Lists, Stats and Settings were seven top-level places for an app with two
 * verbs; the IA is now **Look up**, **Practice**, **Library**, in that order,
 * and everything that was a route is a region of one of them:
 *
 * | was | is |
 * |---|---|
 * | `/` Today, `/lookup` | **Look up** — the box leads, Today is stated beneath it |
 * | `/read` | **Look up**, the pasted-texts view (a sub-path, not a fourth tab) |
 * | `/review` | **Practice** — one session, new words included |
 * | `/lists`, `/lists/:id`, `/stats`, `/settings` | **Library** |
 *
 * `/read` keeps a path of its own because a pasted text is a place a learner
 * comes back to and a browser needs something to bookmark; it is *inside* the
 * Look up tab, which stays marked while it is open. `web.md` W1's route table
 * reads `TAB_PATHS` rather than carrying its own copy, so the nav and the router
 * cannot disagree — the thing `NAV_ITEMS` was for before.
 *
 * **The accents are §1's, by meaning.** Jade is Look up, vermillion is Practice
 * and the single primary action, gold is "new". Library has none of its own:
 * `neutral` is ink on a `--border` pill, which is the right answer for a
 * destination that is a shelf rather than a verb.
 */
import type { TabKey } from '@/components/screens/navigate';
import type { TabAccent } from '@/components/ui/tab-accent';

export type { TabKey };

export interface TabItem {
  key: TabKey;
  label: string;
  /** The tab's own path. Sub-paths below it keep the tab marked. */
  path: string;
  accent: TabAccent;
  /**
   * One line describing the tab, rendered as the link's tooltip — in **both**
   * shells, identically. It was the wide shell's subtitle for one draft, which
   * made the wide shell show a sentence the phone did not and each screen's own
   * `PageHeader` say the same thing twice. Recorded in HANDOFF.md.
   */
  blurb: string;
}

export const TABS: readonly TabItem[] = [
  {
    key: 'lookup',
    label: 'Look up',
    path: '/',
    accent: 'lookup',
    blurb: 'Hanzi, pinyin or English — one box, no mode picker.',
  },
  {
    key: 'practice',
    label: 'Practice',
    path: '/practice',
    accent: 'practice',
    blurb: 'One session: new words, recognising them, and writing them.',
  },
  {
    key: 'library',
    label: 'Library',
    path: '/library',
    accent: 'neutral',
    blurb: 'Your lists, your texts, how it is going, and your settings.',
  },
];

/** Every path the tab shell owns, including the sub-paths inside a tab. */
export const TAB_PATHS = {
  lookup: '/',
  texts: '/read',
  practice: '/practice',
  library: '/library',
  /** One list. `:id` for the router; `listPath()` for a real one. */
  list: '/library/lists/:id',
} as const;

export function listPath(id: string): string {
  return `/library/lists/${id}`;
}

/**
 * Which tab a path belongs to, or `undefined` off the tab shell entirely.
 *
 * Longest prefix wins, and `'/'` is exact — the same rule `nav-link.tsx` used
 * for the seven routes, and the reason `/library/lists/x` marks Library rather
 * than nothing.
 */
export function tabForPath(pathname: string): TabKey | undefined {
  if (pathname === TAB_PATHS.lookup || pathname.startsWith(TAB_PATHS.texts)) return 'lookup';
  if (pathname.startsWith(TAB_PATHS.practice)) return 'practice';
  if (pathname.startsWith(TAB_PATHS.library)) return 'library';
  return undefined;
}
