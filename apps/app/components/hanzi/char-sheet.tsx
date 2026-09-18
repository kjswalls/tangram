'use client';

/**
 * The character sheet (docs/plans/core.md C4; product rule 2).
 *
 * A second tap — on one character inside a word the word sheet is already
 * showing — opens that character on its own: at display size with its speaker,
 * its own readings and glosses, its decomposition, and the learner's own cards
 * that contain it.
 *
 * **The licence rule is load-bearing here and this is the only screen that
 * touches it.** `data/decomp.json` is Make Me a Hanzi, LGPL-3.0-or-later. It is
 * *displayed* and it **never** enters a card snapshot, the SQLite dictionary or
 * a model prompt (CLAUDE.md, "Data and licences"; PLAN.md §5). Concretely, in
 * this file: the decomposition is read into local state and rendered, and the
 * Add path below hands `EntryDetail` an `Entry` — the dictionary's own row —
 * and nothing from `DecompStore`. `tests/unit/hanzi/decomp-licence.test.ts`
 * asserts the snapshot builder's output for a card added from here carries no
 * `DecompEntry` field.
 *
 * **"Words you have with this character" is the learner's own deck**, filtered
 * in the client from `allCards()`. C4 says so explicitly and says not to add a
 * repository method for it: a solo learner's deck is small, and a query that
 * existed only for this panel would be a schema commitment made for a sidebar.
 * Searching the **whole dictionary** for words containing the character is a
 * different question — STACK §5.6's optional `chars` table, `data.md`'s call,
 * not this plan's — so that list arrives as a prop and is absent until someone
 * passes it.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';

import { HanziWord } from '@/components/hanzi/hanzi-text';
import { EntryDetail } from '@/components/lookup/entry-detail';
import { SpeakButton } from '@/components/tts/speak-button';
import { Badge } from '@/components/ui/badge';
import { Sheet } from '@/components/ui/sheet';
import { getRepository } from '@/lib/db/get-db';
import type { DecompStore } from '@/lib/dict/decomp-store';
import type { SearchGroup } from '@/lib/dict/search';
import type { DictStore } from '@/lib/dict/store';
import type { CardContext, DecompEntry, Entry } from '@/lib/types';

/** Exactly the `DictStore` surface this sheet uses. A `DictStore` satisfies it. */
export type CharSheetSource = Pick<DictStore, 'search'>;

export interface CharSheetProps {
  open: boolean;
  /** One character. More than one is a word, and that is the word sheet. */
  char: string;
  store: CharSheetSource;
  decomp: DecompStore;
  /** The sentence the character was met in, so an Add keeps its provenance. */
  context?: CardContext | undefined;
  /**
   * Every headword in the DICTIONARY containing this character, when someone
   * can answer that — `DictStore.wordsContaining` once `data.md` decides the
   * `chars` table ships. A prop, per C4: this plan does not make that call.
   */
  wordsContaining?: readonly Entry[] | undefined;
  onClose: () => void;
}

interface Looked {
  char: string;
  group?: SearchGroup;
  dictVersion?: string;
  error?: string;
}

export function CharSheet({
  open,
  char,
  store,
  decomp,
  context,
  wordsContaining,
  onClose,
}: CharSheetProps) {
  const [looked, setLooked] = useState<Looked>();
  /**
   * Keyed by the character, like `looked`.
   *
   * `char` is a prop that changes while this component stays mounted — the
   * reader keeps one `CharSheet` and swaps it — so an unkeyed piece of state
   * outlives the character it describes. Unkeyed, the sheet showed 续 at display
   * size with 继's decomposition, radical and definition underneath it, under a
   * heading that says "How it is built" and a Make Me a Hanzi attribution. A
   * wrong decomposition under a right character is exactly the kind of quiet
   * falsehood this product is built to avoid.
   */
  const [parts, setParts] = useState<{ char: string; entry: DecompEntry | null }>();

  useEffect(() => {
    if (!open || !char) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await store.search(char);
        if (cancelled) return;
        // The exact headword, not the first result: a one-character search
        // matches every word starting with it, and this sheet is about the
        // character.
        const exact = result.groups.find((group) => group.simp === char || group.trad === char);
        setLooked({
          char,
          ...(exact === undefined ? {} : { group: exact }),
          ...(result.dictVersion === undefined ? {} : { dictVersion: result.dictVersion }),
        });
      } catch {
        if (!cancelled) setLooked({ char, error: 'Could not reach the dictionary.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, char, store]);

  useEffect(() => {
    if (!open || !char) return;
    let cancelled = false;
    void (async () => {
      try {
        const [first] = await decomp.decompose(char);
        if (!cancelled) setParts({ char, entry: first?.entry ?? null });
      } catch {
        // Decomposition is a nicety; failing to get it must not blank the sheet.
        if (!cancelled) setParts({ char, entry: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, char, decomp]);

  /**
   * The learner's own cards containing this character. Filtered in the client
   * from `allCards()` — see the header for why there is no repository method.
   * `deletedAt` is already excluded by `allCards()`.
   */
  const mine = useLiveQuery(async () => {
    if (!char) return [];
    const cards = await getRepository().allCards();
    return cards.filter((card) => {
      const snapshot = card.snapshot;
      // A phrase snapshot has no `trad`; both shapes have `simp`.
      const trad = 'trad' in snapshot ? snapshot.trad : undefined;
      return snapshot.simp.includes(char) || (trad?.includes(char) ?? false);
    });
  }, [char]);

  const current = looked?.char === char ? looked : undefined;
  const decomposition = parts?.char === char ? parts.entry : undefined;
  const entry = current?.group?.entries[0];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={char || 'Character'}
      data-testid="char-sheet"
      aside={entry ? <SpeakButton text={char} label={char} /> : undefined}
    >
      <p className="text-center text-7xl font-medium">
        <HanziWord
          text={char}
          {...(entry?.pinyinNum === undefined ? {} : { pinyinNum: entry.pinyinNum })}
          force
          rtClassName="text-[0.24em]"
          data-testid="char-sheet-hanzi"
        />
      </p>

      {current?.error ? (
        <p className="mt-4 text-sm text-warning">{current.error}</p>
      ) : current?.group ? (
        <div className="mt-4">
          <EntryDetail
            key={current.group.key}
            group={current.group}
            query={char}
            {...(context === undefined ? {} : { context })}
            {...(current.dictVersion === undefined ? {} : { dictVersion: current.dictVersion })}
          />
        </div>
      ) : current ? (
        <p className="mt-4 text-sm text-muted">
          CC-CEDICT has no entry for this character on its own. It is still a character — it is
          just not a headword.
        </p>
      ) : (
        <p className="mt-4 text-sm text-muted">Looking it up…</p>
      )}

      <div className="mt-4 border-t border-border pt-3" data-testid="char-decomposition">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          How it is built
        </h3>
        {decomposition === undefined ? (
          <p className="mt-1 text-sm text-muted">…</p>
        ) : decomposition === null ? (
          <p className="mt-1 text-sm text-muted">No decomposition for this character.</p>
        ) : (
          <p className="mt-1 text-sm">
            {/*
              An IDS string and a radical are a decomposition, not a word: no
              reading to annotate, and `lang` is all they need (C0 rule 2).
            */}
            <span className="hanzi text-lg" lang="zh-Hans" data-testid="char-ids">
              {decomposition.decomposition}
            </span>
            <span className="text-muted">
              {' · radical '}
              <span className="hanzi" lang="zh-Hans">
                {decomposition.radical}
              </span>
              {decomposition.definition ? ` · ${decomposition.definition}` : ''}
            </span>
          </p>
        )}
        <p className="mt-1 text-[0.7rem] text-muted">
          Decomposition from Make Me a Hanzi (LGPL-3.0-or-later).
        </p>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
          Your words with {char}
        </h3>
        {mine === undefined ? (
          <p className="mt-1 text-sm text-muted">…</p>
        ) : mine.length === 0 ? (
          <p className="mt-1 text-sm text-muted">None yet.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2" data-testid="char-my-words">
            {mine.slice(0, 24).map((card) => (
              <li key={card.id}>
                <Badge>
                  {/* Through `<HanziText>` like every other Chinese run
                      (core.md C3). The snapshot carries the reading, so these
                      are annotated rather than bare. */}
                  <HanziWord
                    text={card.snapshot.simp}
                    {...('pinyinNum' in card.snapshot && card.snapshot.pinyinNum
                      ? { pinyinNum: card.snapshot.pinyinNum }
                      : {})}
                  />
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {wordsContaining && wordsContaining.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            Other words with {char}
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2" data-testid="char-dict-words">
            {wordsContaining.slice(0, 24).map((word) => (
              <li key={word.id}>
                <Badge tone="accent">
                  <HanziWord text={word.simp} pinyinNum={word.pinyinNum} />
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Sheet>
  );
}
