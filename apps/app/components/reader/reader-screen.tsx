'use client';

/**
 * The reading view: the segmented text, the sheets over it, and — since C5b —
 * the drag-to-select-a-span interaction (PLAN.md §3.5; docs/plans/core.md C5b).
 *
 * A tap is one call — `openLookup({query, entryIds, context})` — and everything
 * downstream of it is the lookup store's own machinery. The reader's job is the
 * `context`: `lib/reader/sentence.ts` turns the span's offsets into the
 * sentence it sits in and its position inside that sentence, which is what the
 * review back highlights later (§1, commitment 2).
 *
 * **What C5b changed here.** `reader-text.tsx` is gone; the passage is a
 * `<HanziText>` with the token grouping as its runs, so it gets per-character
 * ruby (rule 1) and a character-granular DOM for free. The selection is a span
 * of **characters** in `lib/stores/reader.ts`, made either by a tap on a word,
 * by a drag, or by the two-tap degrade when the engine has no caret API. The
 * `data-testid="reader-token"` / `data-state` hooks survive verbatim, because
 * `tests/e2e/p5/helpers.ts` reads them and the colouring is the only place a
 * learner sees the known-word set the whole product loop is built on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { CharSheet } from '@/components/hanzi/char-sheet';
import { useContextGloss } from '@/components/hanzi/context-gloss';
import { HanziText, type HanziRun } from '@/components/hanzi/hanzi-text';
import { usePinyinDisplay } from '@/components/hanzi/pinyin-display';
import { useSpanClipboard, writeSpan } from '@/components/hanzi/span-clipboard';
import { useSpanSelect } from '@/components/hanzi/use-span-select';
import { WordSheet } from '@/components/hanzi/word-sheet';
import { useReaderIndex } from '@/components/reader/use-reader-index';
import { useReaderReadings } from '@/components/reader/use-reader-readings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { hasCjk } from '@/lib/dict/rank';
import { sentenceAt } from '@/lib/reader/sentence';
import { tokenStates } from '@/lib/reader/states';
import { getDecompStore, getDictStore } from '@/lib/dict/browser-store';
import { useLookupStore } from '@/lib/stores/lookup';
import { nextExtendable, spanOf, tokenAt, useReaderStore } from '@/lib/stores/reader';
import type { WordState } from '@/lib/srs/states';
import type { CardContext, Token } from '@/lib/types';

/** Clear of the sticky header, and clear of the sheet. */
const SHEET_SAFE_TOP = 96;

/** The provenance every card mined from the reader carries. */
function readerContext(body: string, start: number, end: number): CardContext {
  const span = sentenceAt(body, start, end);
  return {
    sentence: span.sentence,
    offset: span.offset,
    length: span.length,
    source: 'reader',
    addedAt: Date.now(),
  };
}

export function ReaderScreen() {
  const body = useReaderStore((state) => state.body);
  const title = useReaderStore((state) => state.title);
  const tokens = useReaderStore((state) => state.tokens);
  const selected = useReaderStore((state) => state.selected);
  const spanEnd = useReaderStore((state) => state.spanEnd);
  const selectToken = useReaderStore((state) => state.selectToken);
  const selectSpan = useReaderStore((state) => state.selectSpan);
  const clearSelection = useReaderStore((state) => state.clearSelection);
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

  const display = usePinyinDisplay();
  // `'never'` asks for no annotation anywhere, so the readings are not fetched
  // at all: the one surface where that read is hundreds of ids wide is this one.
  const readings = useReaderReadings(tokens, display !== 'never');

  const runs = useMemo<HanziRun[]>(
    () =>
      tokens.map((token) => {
        const reading = token.kind === 'word' ? readings.get(token.entryIds[0] ?? '') : undefined;
        return {
          text: token.text,
          // A word token is a word whatever the dictionary knows: `via:
          // 'fallback'` words have no headword and no reading, and they are
          // still tappable and still coloured `new`.
          ...(token.kind === 'word' ? { word: true } : {}),
          ...(reading === undefined ? {} : { pinyinNum: reading }),
        };
      }),
    [tokens, readings],
  );

  const index = useReaderIndex();
  const states = useMemo(
    () => (index ? tokenStates(tokens, index) : tokens.map(() => undefined)),
    [tokens, index],
  );

  const span = useMemo(
    () => spanOf({ tokens, body, selected, spanEnd }),
    [tokens, body, selected, spanEnd],
  );

  /** Open the lookup for a character span, with the provenance a card needs. */
  const openSpan = useCallback(
    (from: number, to: number, ids?: readonly string[]) => {
      selectSpan(from, to);
      const text = body.slice(from, to + 1);
      if (!text) return;
      openLookup({
        query: text,
        // No `entryIds` for a multi-token span: the concatenation is not a
        // token, so the panel asks the dictionary whether it is a headword at
        // all rather than being told one it never resolved.
        ...(ids && ids.length > 0 ? { entryIds: [...ids] } : {}),
        context: readerContext(body, from, to + 1),
      });
    },
    [body, openLookup, selectSpan],
  );

  /**
   * The drag (C5b, promoted from C5a's harness).
   *
   * `revision` is `runs` rather than `tokens`: the readings land a beat after
   * the passage does and turn every plain run into a tree of `<ruby>`, so a map
   * keyed only on the tokens would index a DOM that no longer exists and every
   * index after the first annotated word would be wrong.
   */
  const spanSelect = useSpanSelect({
    selection: selected === undefined ? null : { from: selected, to: spanEnd ?? selected },
    revision: runs,
    // Only Chinese characters are valid span ENDPOINTS; punctuation and Latin
    // are valid interiors. A drag that starts or ends on a comma snaps inward.
    isEndpoint: hasCjk,
    onCommit: (made) => {
      if (!made) return;
      const single = singleToken(tokens, made.from, made.to);
      openSpan(made.from, made.to, single?.entryIds);
    },
  });

  // Cmd/Ctrl+C with a span active. The listener is on the document, because a
  // `user-select: none` passage has no selection for a `copy` event to target.
  useSpanClipboard(span?.text ?? null);

  /**
   * Lift the tapped word clear of the sheet (core.md C4).
   *
   * On a phone the sheet covers the lower two thirds, so a word tapped near the
   * bottom would answer from behind it. This runs after the sheet has opened —
   * two frames, because the first commits the column's bottom padding and the
   * second lays it out.
   *
   * The media query is the complement of the `wide:` variant, so the boundary
   * cannot drift from C1's `--breakpoint-wide: 45rem`; above it the sheet is a
   * side panel and covers nothing.
   */
  const anchorToken = selected === undefined ? undefined : tokenAt(tokens, selected);
  useEffect(() => {
    if (anchorToken === undefined) return;
    // jsdom implements neither `matchMedia` nor layout, so there is nothing to
    // scroll and nothing to measure; the criterion this serves is a Playwright
    // one (core.md C4) and the unit suite must not throw on the way past it.
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(min-width: 45rem)').matches) return;
    let frame = 0;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const target = document.querySelector(`[data-token-index="${anchorToken}"]`);
        if (!target) return;
        const top = target.getBoundingClientRect().top;
        if (top > SHEET_SAFE_TOP) window.scrollBy({ top: top - SHEET_SAFE_TOP });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorToken]);

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
      clearSelection();
      closeLookup();
    },
    [clearSelection, closeLookup],
  );

  const counts = useMemo(() => {
    const tally: Record<WordState, number> = { known: 0, learning: 0, new: 0 };
    for (const state of states) if (state) tally[state] += 1;
    return tally;
  }, [states]);

  const openToken = (at: number) => {
    const token = tokens[at];
    if (!token || token.kind !== 'word') return;
    selectToken(at);
    openLookup({
      query: token.text,
      entryIds: token.entryIds,
      context: readerContext(body, token.start, token.end),
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
          const made = extend();
          if (!made) return;
          openLookup({
            // No `entryIds`: the concatenated span is not a token, so the panel
            // asks the dictionary whether it is a headword at all.
            query: made.text,
            context: readerContext(body, made.start, made.end),
          });
        };

  const close = () => {
    clearSelection();
    closeLookup();
  };

  const open = selected !== undefined;
  /**
   * The two-tap degrade's affordance (C5a's fallback, in production).
   *
   * Shown only when the engine offers **no** caret API, which is what makes the
   * degrade exercised rather than hypothetical: with one, the drag is the
   * gesture and a second control would be clutter. It lives in the toolbar
   * rather than in the sheet because on a phone the sheet covers the lower two
   * thirds and this control has to stay reachable while the learner taps the
   * far end of the span.
   */
  const degraded = spanSelect.api === 'none';

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

      {/*
        **The degrade's control, on its own row and on the left.**
        It started in the toolbar row's right-hand group and was unreachable
        there: at a wide width the word sheet is a right-aligned side panel and
        sat on top of it, so the click that arms the span landed on the sheet's
        "Reading" heading. The sheet is bottom-anchored on a phone and
        right-anchored above 45rem, so a left-aligned control above the passage
        is clear of both — and it has to stay reachable while the learner hunts
        for the far end of the span.
      */}
      {degraded && open ? (
        <div className="flex">
          <Button
            variant={spanSelect.anchor === null ? 'secondary' : 'primary'}
            size="sm"
            data-testid="span-to-here"
            aria-pressed={spanSelect.anchor !== null}
            onClick={() =>
              spanSelect.setAnchor(spanSelect.anchor === null ? (selected ?? null) : null)
            }
          >
            {spanSelect.anchor === null ? 'Select to…' : '…to here'}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start">
        <div className={cn('order-1', open && 'pb-[65dvh] md:pb-0')}>
          <HanziText
            data-testid="reader-text"
            runs={runs}
            states={states}
            wordTestId="reader-token"
            plainRunTestId="reader-text-run"
            span={selected === undefined ? null : { from: selected, to: spanEnd ?? selected }}
            spanSelect={spanSelect}
            onWord={openToken}
            className="text-xl leading-loose break-words whitespace-pre-wrap"
          />
          <p className="mt-4 text-xs text-muted">
            Underlined is{' '}
            <span className="token-new underline decoration-new decoration-dotted decoration-2 underline-offset-4">
              new
            </span>
            , shaded is{' '}
            <span className="token-learning rounded bg-lookup-soft px-1 text-lookup">learning</span>
            , and what you already know is plain.
          </p>
        </div>

        <div className="order-2 md:sticky md:top-4">
          {open ? null : (
            <p className="hidden text-sm text-muted md:block" data-testid="reader-panel-empty">
              Tap a word to look it up, or drag across several. What you add keeps the sentence you
              met it in.
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
        onCharacter={(char, at) => setCharacter({ char, index: at })}
        {...(onExtend ? { onExtend } : {})}
        {...(nextIndex === undefined ? {} : { extendLabel: `Extend to ${tokens[nextIndex].text}` })}
        // There is no Cmd+C on a phone and no native selection to long-press on
        // a `user-select: none` passage (C5b).
        {...(span ? { onCopySpan: () => void writeSpan(span.text) } : {})}
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

/**
 * The token a span covers exactly, if it covers exactly one.
 *
 * A drag that happens to land on one word's boundaries is that word, and the
 * panel should be handed its resolved `entryIds` rather than being made to
 * re-search the string — which is the difference between a card that carries
 * the reading the reader coloured and one that carries the first search hit.
 */
function singleToken(tokens: readonly Token[], from: number, to: number): Token | undefined {
  const token = tokens[tokenAt(tokens, from) ?? -1];
  if (!token || token.kind !== 'word') return undefined;
  return token.start === from && token.end === to + 1 ? token : undefined;
}
