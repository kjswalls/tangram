'use client';

import { useEffect } from 'react';

import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { getDecompStore, getDictStore } from '@/lib/dict/browser-store';

/**
 * Exposes the repository and the dictionary on `window.__tangram` so end-to-end
 * specs can seed and inspect state through `page.evaluate`. Tangram is a
 * single-user, local-first app: the data on this window is already the user's
 * own, so there is nothing to protect by hiding it. Mounted once from the root
 * layout.
 *
 * **`dict` and `decomp` arrived with `data.md` D6.** Two specs read an entry's
 * HSK band to decide whether the learner should already know it, and they did it
 * with a `fetch` of the entries route. There is no route now — the dictionary is
 * on the device — so they ask the same store the app asks. It is a getter, so
 * nothing is constructed (and no 43 MB import is started) unless a spec asks.
 */
export function TestHooks() {
  useEffect(() => {
    const w = window as typeof window & { __tangram?: unknown };
    w.__tangram = {
      get repo() { return getRepository(); },
      get db() { return getDb(); },
      get dict() { return getDictStore(); },
      get decomp() { return getDecompStore(); },
      getRepository,
      getDb,
      closeDb,
    };
  }, []);
  return null;
}
