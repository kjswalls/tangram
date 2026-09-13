'use client';

/**
 * The colouring inputs, read live (PLAN.md §3.5).
 *
 * `useLiveQuery` rather than a one-shot read because the reader is the one
 * screen where the answer changes *while you are looking at it*: an Add from the
 * panel makes a card, "Mark known" writes a `known_words` row, and the token
 * behind the panel has to recolour without the paragraph being segmented again.
 * Dexie observes the three tables the querier touches, so both paths recolour
 * with no explicit invalidation and no polling.
 *
 * The HSK band lists come from the shared `EntrySource`, which memoises them per
 * process — the second text costs no network at all — so they sit in their own
 * effect keyed on `knownBand` rather than in the live query.
 */

import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';

import { getRepository } from '@/lib/db/get-db';
import { getEntrySource } from '@/lib/lists/entry-source';
import { buildReaderIndex, type ReaderIndex } from '@/lib/reader/states';
import { HSK_BANDS, type EntryId, type HskBand } from '@/lib/types';

interface Bands {
  /** The `knownBand` these were fetched for — a stale set colours the wrong words. */
  band: HskBand;
  map: ReadonlyMap<EntryId, HskBand>;
}

/**
 * `undefined` until *both* halves are in — the cards from Dexie and the bands
 * for the current `knownBand`. Colouring on half the inputs would paint every
 * HSK 1 word `new` for a frame and then repaint it `known`, which is the reader
 * lying about what the learner knows, however briefly. The caller renders the
 * text uncoloured until this answers.
 */
export function useReaderIndex(): ReaderIndex | undefined {
  const live = useLiveQuery(async () => {
    const repo = getRepository();
    const [cards, known, settings] = await Promise.all([
      repo.allCards(),
      repo.knownEntryIds(),
      repo.getSettings(),
    ]);
    return { cards, known, knownBand: settings.knownBand };
  }, []);

  const knownBand = live?.knownBand;
  const [bands, setBands] = useState<Bands>();

  useEffect(() => {
    if (knownBand === undefined) return;
    let cancelled = false;
    const source = getEntrySource();
    void (async () => {
      const map = new Map<EntryId, HskBand>();
      for (const band of HSK_BANDS) {
        if (band > knownBand) break;
        for (const entry of await source.band(band)) map.set(entry.id, band);
      }
      if (!cancelled) setBands({ band: knownBand, map });
    })().catch(() => {
      // No dictionary data, or the route is down: the cards and the declared
      // known words still colour the text. A band is an assumption anyway.
      if (!cancelled) setBands({ band: knownBand, map: new Map() });
    });
    return () => {
      cancelled = true;
    };
  }, [knownBand]);

  return useMemo(
    () =>
      live === undefined || bands?.band !== live.knownBand
        ? undefined
        : buildReaderIndex({
            cards: live.cards,
            known: live.known,
            bands: bands.map,
            knownBand: live.knownBand,
          }),
    [live, bands],
  );
}
