'use client';

/**
 * The text itself: one span per token, coloured by what the learner knows
 * (PLAN.md §3.5).
 *
 * Two things drive the shape. First, `text` tokens — punctuation, Latin,
 * whitespace — are *untappable*: they are not words, they have no state, and a
 * tap on 。 that opened a dictionary panel would be noise. Second, a 2,000
 * character text is ~1,300 tokens, so there is exactly one click handler on the
 * container and the tokens carry their index in a data attribute. A handler per
 * token is 1,300 closures re-created on every recolour.
 *
 * Word tokens are real `<button>`s, so Tab and Enter reach them for free and the
 * delegated handler sees the Enter as a click.
 */

import { memo } from 'react';

import { cn } from '@/lib/cn';
import type { WordState } from '@/lib/srs/states';
import type { Token } from '@/lib/types';

/**
 * The stable hooks are `token-<state>` and `data-state`; the utilities next to
 * them are the paint. `known` is deliberately plain — the point of the reader is
 * that what you know disappears and what you do not stands out.
 */
const STATE_CLASS: Record<WordState, string> = {
  known: 'token-known',
  learning: 'token-learning rounded bg-accent-soft text-accent',
  new: 'token-new rounded underline decoration-warning decoration-dotted decoration-2 underline-offset-4',
};

/** Clear of the sticky header, and clear of the sheet. */
const SHEET_SAFE_TOP = 96;

export interface ReaderTextProps {
  tokens: readonly Token[];
  /** One entry per token; `undefined` for `text` tokens and before the first read. */
  states: readonly (WordState | undefined)[];
  /** Indexes of the tokens in the current span (the tapped one, plus extensions). */
  span?: { from: number; to: number };
  onSelect: (index: number) => void;
  className?: string;
}

function TokenSpan({
  token,
  index,
  state,
  inSpan,
}: {
  token: Token;
  index: number;
  state: WordState | undefined;
  inSpan: boolean;
}) {
  if (token.kind !== 'word') {
    // Rendered, never tapped, never coloured.
    return <span data-testid="reader-text-run">{token.text}</span>;
  }
  return (
    <button
      type="button"
      data-testid="reader-token"
      data-token-index={index}
      data-token={token.text}
      data-state={state ?? 'unknown'}
      className={cn(
        'reader-token cursor-pointer px-0 align-baseline font-[inherit] leading-[inherit] transition-colors',
        state ? STATE_CLASS[state] : undefined,
        inSpan && 'ring-2 ring-accent ring-offset-1 ring-offset-surface',
      )}
    >
      {token.text}
    </button>
  );
}

const Tokens = memo(function Tokens({
  tokens,
  states,
  span,
}: Pick<ReaderTextProps, 'tokens' | 'states' | 'span'>) {
  return (
    <>
      {tokens.map((token, index) => (
        <TokenSpan
          key={`${index}-${token.start}`}
          token={token}
          index={index}
          state={states[index]}
          inSpan={span !== undefined && index >= span.from && index <= span.to}
        />
      ))}
    </>
  );
});

export function ReaderText({ tokens, states, span, onSelect, className }: ReaderTextProps) {
  return (
    <div
      data-testid="reader-text"
      className={cn(
        'hanzi text-xl leading-loose break-words whitespace-pre-wrap',
        className,
      )}
      onClick={(event) => {
        const target = (event.target as HTMLElement).closest('[data-token-index]');
        const index = target?.getAttribute('data-token-index');
        if (index === null || index === undefined) return;
        onSelect(Number(index));
        // On a phone the panel is a bottom sheet over the lower two thirds of
        // the screen, so a word tapped near the bottom would answer from behind
        // it. Lift it to just under the header instead.
        if (target && window.matchMedia('(max-width: 767px)').matches) {
          const top = target.getBoundingClientRect().top;
          if (top > SHEET_SAFE_TOP) window.scrollBy({ top: top - SHEET_SAFE_TOP, behavior: 'smooth' });
        }
      }}
    >
      <Tokens tokens={tokens} states={states} span={span} />
    </div>
  );
}
