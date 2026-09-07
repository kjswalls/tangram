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

import { useEffect, useMemo } from 'react';

import { ReaderLookup } from '@/components/reader/reader-lookup';
import { ReaderText } from '@/components/reader/reader-text';
import { useReaderIndex } from '@/components/reader/use-reader-index';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { sentenceAt } from '@/lib/reader/sentence';
import { tokenStates } from '@/lib/reader/states';
import { useLookupStore } from '@/lib/stores/lookup';
import { nextExtendable, useReaderStore } from '@/lib/stores/reader';
import type { WordState } from '@/lib/srs/states';

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

  const index = useReaderIndex();
  const states = useMemo(
    () => (index ? tokenStates(tokens, index) : tokens.map(() => undefined)),
    [tokens, index],
  );

  // The panel belongs to the token on screen. Leaving the reader — or dropping
  // the text — must not leave a reader context armed for the next route to add
  // a card with.
  useEffect(() => closeLookup, [closeLookup]);

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
          {open ? (
            <ReaderLookup
              onClose={close}
              {...(onExtend ? { onExtend } : {})}
              {...(nextIndex === undefined
                ? {}
                : { extendLabel: `Extend to ${tokens[nextIndex].text}` })}
            />
          ) : (
            <p className="hidden text-sm text-muted md:block" data-testid="reader-panel-empty">
              Tap a word to look it up. What you add keeps the sentence you met it in.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
