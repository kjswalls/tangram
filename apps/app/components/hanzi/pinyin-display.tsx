'use client';

/**
 * The learner's pinyin-visibility setting, made available to every Chinese run
 * (docs/plans/core.md C3; product-decisions §4 rule 1).
 *
 * A context rather than a prop on every call site, and rather than a read
 * inside `<HanziText>` itself. There are thirty rendering sites; threading the
 * setting through all of them is how one gets missed, and a `useLiveQuery`
 * inside `<HanziText>` would mean a database subscription per character run on
 * a passage that has hundreds. One subscription at the root, one context read
 * per run.
 *
 * `<HanziText>`'s own `display` prop still wins where a caller knows better —
 * the gallery pins a value to show all three, and a practice card's answer face
 * sets `force`, which the product says never hides the reading.
 *
 * **The default is `'always'`** and it is the value a component gets with no
 * provider above it, which is what every unit test sees.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, type ReactNode } from 'react';

import { getRepository } from '@/lib/db/get-db';
import { DEFAULT_SETTINGS, type PinyinDisplay } from '@/lib/db/schema';

const PinyinDisplayContext = createContext<PinyinDisplay>(
  DEFAULT_SETTINGS.pinyinDisplay ?? 'always',
);

export function usePinyinDisplay(): PinyinDisplay {
  return useContext(PinyinDisplayContext);
}

/**
 * Reads the setting live, so C8's control in Library changes every rendered
 * passage without a reload. Falls back to the default while the read is in
 * flight — a beginner seeing pinyin for one frame is the harmless direction.
 */
export function PinyinDisplayProvider({ children }: { children: ReactNode }) {
  const display = useLiveQuery(async () => (await getRepository().getSettings()).pinyinDisplay, []);
  return (
    <PinyinDisplayContext.Provider value={display ?? DEFAULT_SETTINGS.pinyinDisplay ?? 'always'}>
      {children}
    </PinyinDisplayContext.Provider>
  );
}
