'use client';

/**
 * The `app` scope's handlers (docs/plans/web.md W8).
 *
 * Mounted once, by `src/root.tsx`, beside the other mounted-once components. It
 * is in `src/` rather than in `components/` because both of its actions are
 * router facts — one navigates, and `core.md` C7 forbids a screen to know what
 * that means.
 *
 * Two bindings, and they are the two W8a can have without a palette: jump to
 * the lookup box, and show the sheet listing every binding.
 */
import { useState } from 'react';

import { useLocation, useNavigate } from 'react-router';

import { LOOKUP_INPUT_ID } from '@/components/lookup/lookup-view';
import { TAB_PATHS } from '@/components/shell/nav';

import { claimRouteFocus } from '@/src/shell/route-announcer';

import { ShortcutHelp } from './shortcut-help';
import { useShortcuts } from './use-shortcuts';

/**
 * Focus the lookup box, whenever it turns up.
 *
 * It may not be there yet, for two ordinary reasons: the shortcut can arrive
 * from another tab, in which case the route has to render first; and the box
 * lives inside `<DictGate>`, so an origin with no dictionary has an ask card
 * where the box will be. So this retries across a few frames and then gives up
 * silently — a shortcut that cannot reach its target must do nothing, not throw
 * and not steal focus from somewhere else as a consolation.
 */
export function focusLookupInput(attempts = 30): void {
  const found = document.getElementById(LOOKUP_INPUT_ID);
  if (found instanceof HTMLInputElement) {
    found.focus();
    // Select rather than append: the box holds the previous search, and
    // "jump to the lookup box" means start a new one.
    found.select();
    return;
  }
  if (attempts <= 0 || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => focusLookupInput(attempts - 1));
}

export function AppShortcuts() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [helpOpen, setHelpOpen] = useState(false);

  useShortcuts('app', {
    'lookup.focus': () => {
      if (pathname !== TAB_PATHS.lookup) {
        // Both this and `<RouteAnnouncer>` want focus on the commit the
        // navigation produces, and the announcer was winning two runs in five.
        // The claim is a deferral with a grace period, not a cancellation —
        // see `src/shell/route-announcer.tsx`. Claimed only when we really
        // navigate, because no route change means nothing would clear it.
        claimRouteFocus(TAB_PATHS.lookup);
        navigate(TAB_PATHS.lookup);
      }
      focusLookupInput();
    },
    'help.show': () => setHelpOpen(true),
  });

  return <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />;
}
