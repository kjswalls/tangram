'use client';

/**
 * The reading view: the segmented text on the left, the lookup panel beside it
 * (PLAN.md §3.5).
 *
 * A tap is one call — `openLookup({query, entryIds, context})` — and everything
 * downstream of it is the lookup route's own machinery. The reader's job is the
 * `context`: `lib/reader/sentence.ts` turns the token's offsets into the
 * sentence it sits in and its position inside that sentence, which is what the
 * review back highlights later (§1, commitment 2).
 */

import { useEffect, useMemo, useState } from 'react';

import { CharSheet } from '@/components/hanzi/char-sheet';
import { useContextGloss } from '@/components/hanzi/context-gloss';
import { WordSheet } from '@/components/hanzi/word-sheet';
import { ReaderText } from '@/components/reader/reader-text';
import { useReaderIndex } from '@/components/reader/use-reader-index';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { sentenceAt } from '@/lib/reader/sentence';
import { tokenStates } from '@/lib/reader/states';
import { getDecompStore, getDictStore } from '@/lib/dict/browser-store';
import { useLookupStore } from '@/lib/stores/lookup';
import { nextExtendable, useReaderStore } from '@/lib/stores/reader';
import type { WordState } from '@/lib/srs/states';

/** Clear of the sticky header, and clear of the sheet. */
const SHEET_SAFE_TOP = 96;

export function ReaderScreen() {
  const body = useReaderStore((state) => state.body);
  const title = useReaderStore((state) => state.title);
  const tokens = useReaderStore((state) => state.tokens);
  const selected = useReaderStore((state) => state.selected);
  const spanEnd = useReaderStore((state) => state.spanEnd);
  const select = useReaderStore((state) => state.select);
  const extend = useReaderStore((state) => state.extend);
  const setView = useReaderStore((state) => state.setView);
  const clear = useReaderStore((state) => state.clear);

  const openLookup = useLookupStore((state) => state.openLookup);
  const closeLookup = useLookupStore((state) => state.closeLookup);
  const query = useLookupStore((state) => state.query);
  const entryIds = useLookupStore((state) => state.entryIds);
  const lookupContext = useLookupStore((state) => state.context);

  // The character sheet stacks on top of the word sheet: rule 2's second tap.
  // The index comes with it so the character's own span can be worked out.
  const [character, setCharacter] = useState<{ char: string; index: number }>();

  const store = getDictStore();
  const decompStore = getDecompStore();

  // §7's third capability: one line on what the word means in THIS sentence.
  // Asked here rather than inside the sheet so that a sheet opened from the
  // search box — which has no sentence — makes no request at all.
  const gloss = useContextGloss(query, lookupContext);

  /**
   * Lift the tapped word clear of the sheet (core.md C4).
   *
   * On a phone the sheet covers the lower two thirds, so a word tapped near the
   * bottom would answer from behind it. `reader-text.tsx` used to do this in
   * its click handler, and it could not work there: it measured the token
   * before the sheet existed and before the column grew the bottom padding that
   * makes the document tall enough to lift it. Here it runs after the sheet has
   * opened — two frames, because the first commits the padding and the second
   * lays it out.
   *
   * The media query is the complement of the `wide:` variant, so the boundary
   * cannot drift from C1's `--breakpoint-wide: 45rem`; above it the sheet is a
   * side panel and covers nothing.
   */
  useEffect(() => {
    if (selected === undefined) return;
    // jsdom implements neither `matchMedia` nor layout, so there is nothing to
    // scroll and nothing to measure; the criterion this serves is a Playwright
    // one (core.md C4) and the unit suite must not throw on the way past it.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(min-width: 45rem)').matches) return;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const target = document.querySelector(`[data-token-index="${selected}"]`);
        if (!target) return;
        const top = target.getBoundingClientRect().top;
        // Clear of the sticky header, and clear of the sheet.
        if (top > SHEET_SAFE_TOP) window.scrollBy({ top: top - SHEET_SAFE_TOP });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  const index = useReaderIndex();
  const states = useMemo(
    () => (index ? tokenStates(tokens, index) : tokens.map(() => undefined)),
    [tokens, index],
  );

  // The panel belongs to the token on screen. Leaving the reader — or dropping
  // the text — must not leave a reader context armed for the next route to add
  // a card with.
  //
  // The selection goes with it. `closeLookup` clears the query, the sentence and
  // the resolved entry ids, but `selected` lives in the reader store and used to
  // survive a trip to /review or the Edit view; on the way back `open` was still
  // true, so the panel reopened on the last tapped token with no sentence and no
  // ids — it re-searched the bare string and any Add carried no provenance at
  // all. The two are one piece of state; they die together.
  useEffect(
    () => () => {
      select(undefined);
      closeLookup();
    },
    [select, closeLookup],
  );

  const counts = useMemo(() => {
    const tally: Record<WordState, number> = { known: 0, learning: 0, new: 0 };
    for (const state of states) if (state) tally[state] += 1;
    return tally;
  }, [states]);

  const openToken = (at: number) => {
    const token = tokens[at];
    if (!token || token.kind !== 'word') return;
    select(at);
    const span = sentenceAt(body, token.start, token.end);
    openLookup({
      query: token.text,
      entryIds: token.entryIds,
      context: {
        sentence: span.sentence,
        offset: span.offset,
        length: span.length,
        source: 'reader',
        addedAt: Date.now(),
      },
    });
  };

  /**
   * The character's own span inside the sentence, not the word's.
   *
   * `lookupContext` locates the whole tapped word, and `lib/srs/context.ts`
   * uses `offset`/`length` to decide what a card back highlights (PLAN.md §1,
   * commitment 2). Handing it straight to the character sheet made a
   * one-character card highlight the two-character word it came out of, for the
   * life of the card. The sentence and the source are the word's; the span is
   * the character's.
   */
  const characterContext =
    lookupContext === undefined
      ? undefined
      : character === undefined || lookupContext.offset === undefined
        ? lookupContext
        : {
            ...lookupContext,
            offset: lookupContext.offset + character.index,
            length: [...character.char].length,
          };

  const nextIndex = nextExtendable({ tokens, selected, spanEnd });
  const onExtend =
    nextIndex === undefined
      ? undefined
      : () => {
          const span = extend();
          if (!span) return;
          const sentence = sentenceAt(body, span.start, span.end);
          openLookup({
            // No `entryIds`: the concatenated span is not a token, so the panel
            // asks `/api/dict/search` whether it is a headword at all.
            query: span.text,
            context: {
              sentence: sentence.sentence,
              offset: sentence.offset,
              length: sentence.length,
              source: 'reader',
              addedAt: Date.now(),
            },
          });
        };

  const close = () => {
    select(undefined);
    closeLookup();
  };

  const open = selected !== undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          className="hanzi min-w-0 flex-1 truncate text-lg font-medium"
          data-testid="reader-heading"
          title={title}
        >
          {title || 'Untitled text'}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent" data-testid="reader-counts">
            {counts.new} new · {counts.learning} learning · {counts.known} known
          </Badge>
          <Button variant="secondary" size="sm" onClick={() => setView('compose')}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" data-testid="new-text" onClick={clear}>
            New text
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start">
        <div className={cn('order-1', open && 'pb-[65dvh] md:pb-0')}>
          <ReaderText
            tokens={tokens}
            states={states}
            {...(selected === undefined
              ? {}
              : { span: { from: selected, to: spanEnd ?? selected } })}
            onSelect={openToken}
          />
          <p className="mt-4 text-xs text-muted">
            Underlined is{' '}
            <span className="token-new underline decoration-warning decoration-dotted decoration-2 underline-offset-4">
              new
            </span>
            , shaded is{' '}
            <span className="token-learning rounded bg-accent-soft px-1 text-accent">
              learning
            </span>
            , and what you already know is plain.
          </p>
        </div>

        <div className="order-2 md:sticky md:top-4">
          {open ? null : (
            <p className="hidden text-sm text-muted md:block" data-testid="reader-panel-empty">
              Tap a word to look it up. What you add keeps the sentence you met it in.
            </p>
          )}
        </div>
      </div>

      {/*
        The two sheets, mounted at the end of the screen rather than inside the
        column, because a `Sheet` is a fixed layer and the column it used to sit
        in is a grid cell (core.md C4; the `Sheet` primitive is C1's).
      */}
      <WordSheet
        open={open}
        // Non-modal, deliberately: the reader's loop is tap-a-word,
        // tap-the-next-word, and a backdrop over the passage would make every
        // word after the first cost two taps — the first to dismiss.
        modal={false}
        query={query}
        {...(entryIds === undefined ? {} : { entryIds })}
        {...(lookupContext === undefined ? {} : { context: lookupContext })}
        store={store}
        gloss={gloss}
        onClose={close}
        onCharacter={(char, index) => setCharacter({ char, index })}
        {...(onExtend ? { onExtend } : {})}
        {...(nextIndex === undefined ? {} : { extendLabel: `Extend to ${tokens[nextIndex].text}` })}
      />
      <CharSheet
        open={character !== undefined}
        char={character?.char ?? ''}
        store={store}
        decomp={decompStore}
        {...(characterContext === undefined ? {} : { context: characterContext })}
        onClose={() => setCharacter(undefined)}
      />
    </div>
  );
}
