'use client';

/**
 * The passage's readings (docs/plans/core.md C5b).
 *
 * **Why this exists, and why it is not in C5b's Files list.** C5b replaces
 * `reader-text.tsx` with `<HanziText>`, and `<HanziText>` annotates from
 * `HanziRun.pinyinNum` — CC-CEDICT's *numbered* form, which is the only one
 * `lib/hanzi/align.ts` can split per character. A `Token` carries `entryIds`
 * and no reading at all (`lib/types.ts`), so without this the reader would be
 * the one surface in the app that shows Chinese with no pinyin over it, which
 * is product rule 1 failing on the screen the rule was written for — and C8's
 * pinyin-control criterion ("switching between them changes what a rendered
 * passage shows") would have nothing to switch. Recorded in HANDOFF.md as an
 * addition to the phase's Files list rather than smuggled in.
 *
 * **One batched read per passage**, through `EntrySource`, which chunks at the
 * 200-id batch the deleted entries route enforced, and memoises the
 * dictionary version. Only the **ranked** id of each word is asked for: ids are
 * frequency-ordered (§3.2) and the first one is the reading a learner sees on
 * the passage, which is the same rule the word sheet's "Mark known" already
 * rests on.
 *
 * **A dictionary outage degrades to no ruby, never to a broken reader.** The
 * tokens are still tappable — `<HanziText>` takes `word: true` from the token's
 * `kind` rather than inferring it from "has a reading" — so a failed read costs
 * the annotations and nothing else. Missing data is a banner, not a crash.
 */

import { useEffect, useState } from 'react';

import { getEntrySource } from '@/lib/lists/entry-source';
import type { EntryId, Token } from '@/lib/types';

/** entryId → CC-CEDICT numbered pinyin, for the ids this passage asked about. */
export type ReadingMap = ReadonlyMap<EntryId, string>;

const EMPTY: ReadingMap = new Map();

/** The ranked (most frequent) id of each word token, de-duplicated, in order. */
export function rankedIds(tokens: readonly Token[]): EntryId[] {
  const seen = new Set<EntryId>();
  for (const token of tokens) {
    if (token.kind !== 'word') continue;
    const id = token.entryIds[0];
    if (id) seen.add(id);
  }
  return [...seen];
}

export function useReaderReadings(tokens: readonly Token[], enabled = true): ReadingMap {
  const [readings, setReadings] = useState<ReadingMap>(EMPTY);

  useEffect(() => {
    if (!enabled || tokens.length === 0) {
      setReadings(EMPTY);
      return;
    }
    const ids = rankedIds(tokens);
    if (ids.length === 0) {
      setReadings(EMPTY);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const entries = await getEntrySource().entries(ids);
        if (cancelled) return;
        const map = new Map<EntryId, string>();
        for (const entry of entries) if (entry.pinyinNum) map.set(entry.id, entry.pinyinNum);
        setReadings(map);
      } catch {
        // See the header: the passage renders and stays tappable without them.
        if (!cancelled) setReadings(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tokens, enabled]);

  return readings;
}
