import type { ReactNode } from 'react';

import { ContextLine } from '@/components/review/context-line';
import { PhraseFace } from '@/components/review/phrase-face';
import { SpeakButton } from '@/components/tts/speak-button';
import { HanziWord } from '@/components/hanzi/hanzi-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { CardRow, ScriptPreference } from '@/lib/db/schema';
import { isPhraseSnapshot } from '@/lib/db/schema';
import { resolveContext } from '@/lib/srs/context';
import { directionOf } from '@/lib/srs/direction';
import { cardBack, cardFace } from '@/lib/srs/presentation';

export interface ReviewCardProps {
  card: CardRow;
  script: ScriptPreference;
  revealed: boolean;
  peeked: boolean;
  onPeek: () => void;
  onReveal: () => void;
  /**
   * The free-recall box (Phase 6 item 2), on the **front**, under the hanzi.
   * It sits on the front because recall is what the learner does before they
   * see the answer; this component owns where it goes and nothing else about
   * it, so the whole feature — the toggle that gates it, the grading call, the
   * suggested grade — lives in the slot's owner.
   */
  recall?: ReactNode;
  /**
   * The i+1 example sentences (Phase 6 item 1), on the **back**, under the
   * glosses: after the learner has seen the meaning, not instead of it.
   */
  examples?: ReactNode;
  /**
   * Anything the back offers to *do* with this card, under the meaning — Phase
   * 8's "add the reverse" is the first. It is a slot for the same reason the
   * other two are: the card decides where a control goes and the slot's owner
   * decides what it does, so nothing here has to know what a direction is.
   */
  actions?: ReactNode;
}

/**
 * One card, front and back (PLAN.md §4, P2).
 *
 * The front is the hanzi and nothing else — plus the option to peek at the
 * sentence it was met in, with the target masked. The back adds the reading,
 * the senses (the chosen one first), the classifiers, the HSK band, and the
 * same sentence with the target marked.
 */
export function ReviewCard({
  card,
  script,
  revealed,
  peeked,
  onPeek,
  onReveal,
  recall = null,
  examples = null,
  actions = null,
}: ReviewCardProps) {
  const face = cardFace(card.snapshot, script);
  const back = cardBack(card);
  const context = resolveContext(
    card.context,
    [face.primary, face.secondary].filter((value): value is string => Boolean(value)),
  );
  const canPeek = context !== null && context.parts !== null;
  const phrase = isPhraseSnapshot(card.snapshot) ? card.snapshot : null;

  return (
    <article
      data-testid="review-card"
      data-card-id={card.id}
      // Recognition, in every case: the production direction has a card of its
      // own (`components/review/production-card.tsx`). It is stated rather than
      // assumed so that "which way round is this card?" is one attribute on
      // both, for a reader and for a test.
      data-direction={directionOf(card)}
      data-revealed={revealed ? 'true' : 'false'}
      className="rounded-xl border border-border bg-surface"
    >
      <div
        data-testid="card-front"
        className={cn(
          'flex flex-col items-center gap-4 px-4 py-10 text-center',
          !revealed && 'cursor-pointer',
        )}
        onClick={revealed ? undefined : onReveal}
        role={revealed ? undefined : 'button'}
        tabIndex={revealed ? undefined : 0}
        onKeyDown={
          revealed
            ? undefined
            : (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onReveal();
                }
              }
        }
        aria-label={revealed ? undefined : 'Show the answer'}
      >
        {phrase ? (
          <PhraseFace card={card} />
        ) : (
          <h2 className="text-6xl font-medium sm:text-7xl">
            {/*
              **The question side shows no reading, whatever the setting says.**

              `display="never"` is the mirror of the `force` on the answer face
              below, and it is not what C3 first built: the front rendered
              unforced, which with the default `pinyinDisplay: 'always'` meant
              a fresh install printed 打(dǎ)算(suàn) above the headword and then
              offered `dǎsuàn` as the answer a keypress later. Recognition
              grading answered itself. `phrase-face.tsx` had the rule already —
              "this is the front of a review card, where the reading is the
              answer" — and the two card types disagreed.

              The line that settles it: `pinyinDisplay` governs **reading**
              surfaces (lookup, the reader, lists, example sentences), not the
              side of a practice card whose job is to withhold. Recorded in
              HANDOFF.md, because core.md C3 states only the `force` half.

              `revealed` is what flips it, and this element is where it has to
              flip: the headword is rendered once, on the front, and the back
              is appended below it — so the answer face never re-renders the
              characters and `force` further down would annotate nothing. On
              reveal the reading appears over each character, which is the
              per-character mapping the learner is here for and the thing
              `card-pinyin`'s joined `dǎsuàn` cannot show.
            */}
            <HanziWord
              text={face.primary}
              {...(revealed && face.pinyinNum !== undefined
                ? { pinyinNum: face.pinyinNum, force: true }
                : { display: 'never' as const })}
              rtClassName="text-[0.28em]"
            />
          </h2>
        )}
        {face.secondary ? (
          <p className="text-2xl text-muted">
            <span className="sr-only">{face.secondaryLabel}: </span>
            {/* The other script of the same question: same rule. */}
            <HanziWord
              text={face.secondary}
              {...(revealed && face.pinyinNum !== undefined
                ? { pinyinNum: face.pinyinNum, force: true }
                : { display: 'never' as const })}
            />
          </p>
        ) : null}

        {recall ? (
          <div
            data-testid="card-recall"
            className="w-full max-w-prose text-left"
            // The box takes typing and Enter; the front is a button that
            // reveals on either. Without this a keystroke into the answer
            // would flip the card it is about.
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {recall}
          </div>
        ) : null}

        {context && !revealed ? (
          <div className="w-full max-w-prose text-left">
            {peeked ? (
              <>
                <p className="mb-1 text-xs tracking-wide text-muted uppercase">{context.label}</p>
                <ContextLine context={context} mode="masked" />
              </>
            ) : canPeek ? (
              <div className="text-center">
                <Button
                  data-testid="peek-context"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPeek();
                  }}
                >
                  Peek context
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {revealed ? (
        <div data-testid="card-back" className="space-y-4 border-t border-border px-4 py-5 sm:px-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p data-testid="card-pinyin" className="text-xl font-medium text-accent">
              {back.pinyinMarked}
            </p>
            <SpeakButton text={face.primary} label={face.primary} />
            {face.secondary ? (
              <p className="text-sm text-muted">
                {face.secondaryLabel}{' '}
                <HanziWord
                  text={face.secondary}
                  {...(face.pinyinNum === undefined ? {} : { pinyinNum: face.pinyinNum })}
                  // The BACK of the card: the product never hides the reading
                  // here, whatever the setting says (product-decisions §4).
                  force
                />
              </p>
            ) : null}
            {back.hskLabel ? <Badge tone="accent">{back.hskLabel}</Badge> : null}
          </div>

          {phrase ? (
            <p data-testid="card-en" className="text-base">
              {phrase.en}
            </p>
          ) : (
            <ol data-testid="card-glosses" className="list-inside list-decimal space-y-1 text-base">
              {back.glosses.chosen.map((gloss) => (
                <li key={gloss}>{gloss}</li>
              ))}
            </ol>
          )}

          {back.glosses.others.length > 0 ? (
            <details data-testid="other-senses" className="text-sm text-muted">
              <summary className="cursor-pointer">
                Other senses ({back.glosses.others.length})
              </summary>
              <ul className="mt-2 list-inside list-disc space-y-1">
                {back.glosses.others.map((gloss) => (
                  <li key={gloss}>{gloss}</li>
                ))}
              </ul>
            </details>
          ) : null}

          {examples ? <div data-testid="card-examples">{examples}</div> : null}

          {back.classifiers.length > 0 ? (
            <p data-testid="card-classifiers" className="text-sm text-muted">
              Classifier{' '}
              <HanziWord text={back.classifiers.join(' · ')} className="text-ink" force />
            </p>
          ) : null}

          {actions ? <div data-testid="card-actions">{actions}</div> : null}

          {card.note ? (
            <p data-testid="card-note" className="text-sm text-muted italic">
              {card.note}
            </p>
          ) : null}

          {context ? (
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="mb-1 text-xs tracking-wide text-muted uppercase">{context.label}</p>
              <ContextLine context={context} mode="highlight" />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
