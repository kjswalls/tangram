import type { ReactNode } from 'react';

import { ContextLine } from '@/components/review/context-line';
import { SpeakButton } from '@/components/tts/speak-button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { CardRow, ScriptPreference } from '@/lib/db/schema';
import { maskedContext, resolveContext } from '@/lib/srs/context';
import { maskTargets, revealsTarget, wordSnapshot } from '@/lib/srs/direction';
import { cardBack, cardFace } from '@/lib/srs/presentation';

export interface ProductionCardProps {
  card: CardRow;
  script: ScriptPreference;
  revealed: boolean;
  onReveal: () => void;
  /**
   * The answer box — `RecallInput`, the same component the meaning direction
   * uses, handed a local grader instead of the meaning one
   * (`productionRecallRequest`). It is the *question* on this card rather than
   * an optional extra, so the session mounts it whatever `settings.freeRecall`
   * says.
   */
  recall?: ReactNode;
  /** i+1 sentences, on the back — they contain the answer. */
  examples?: ReactNode;
}

/**
 * The production card: the meaning on the front, the hanzi recalled (PLAN.md
 * §3.3; Phase 8, builder B).
 *
 * It is a separate component rather than a mode of `ReviewCard` because the two
 * fronts have opposite duties. The recognition front shows the word and hides
 * the meaning; this one shows the meaning and must hide **every** trace of the
 * word — which is more than not printing it:
 *
 *  - the chosen sense leads, exactly as the recognition back orders it, but a
 *    gloss that quotes the headword ("variant of 打算[da3 suan4]") is blanked,
 *    reading and all (`maskTargets`);
 *  - the sentence the word was met in is shown with the target blanked, and
 *    only when it can be blanked — a sentence whose target cannot be located,
 *    or that says the word a second time somewhere else, is not shown at all;
 *  - there is no pinyin and there are no classifiers on the front. The reading
 *    is most of the answer.
 *
 * The back is the ordinary card back: the hanzi, the other script, the reading,
 * the senses in full, and the sentence with the target marked.
 */
export function ProductionCard({
  card,
  script,
  revealed,
  onReveal,
  recall = null,
  examples = null,
}: ProductionCardProps) {
  const snapshot = wordSnapshot(card.snapshot);
  const face = cardFace(card.snapshot, script);
  const back = cardBack(card);
  const forms = snapshot
    ? [snapshot.simp, snapshot.trad].filter((form) => form.length > 0)
    : [];

  // The prompt: the sense the card is about, then the rest of the entry. Both
  // are masked — the headword can appear in any gloss, not only the chosen one.
  const prompt = (back.en ? [back.en] : back.glosses.chosen).map((gloss) =>
    maskTargets(gloss, forms),
  );
  const alsoMeans = back.glosses.others.map((gloss) => maskTargets(gloss, forms));

  const context = resolveContext(card.context, forms);
  const masked = context ? maskedContext(context.parts) : null;
  // A masked line that still spells the word out — the sentence uses it twice,
  // and only the located occurrence was blanked — is not shown. Nothing is a
  // better front than a hint that is the answer.
  const showMasked = context !== null && masked !== null && !revealsTarget(masked, forms);

  return (
    <article
      data-testid="review-card"
      data-card-id={card.id}
      data-direction="production"
      data-revealed={revealed ? 'true' : 'false'}
      className="rounded-xl border border-border bg-surface"
    >
      <div
        data-testid="card-front"
        className={cn(
          'flex flex-col items-center gap-4 px-4 py-8 text-center',
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
        <p className="text-xs tracking-wide text-muted uppercase">Write this in Chinese</p>

        <ol data-testid="production-prompt" className="space-y-1 text-2xl leading-snug font-medium">
          {prompt.map((gloss, index) => (
            <li key={`${gloss}-${index}`}>{gloss}</li>
          ))}
        </ol>

        {alsoMeans.length > 0 ? (
          <p data-testid="production-other-senses" className="max-w-prose text-sm text-muted">
            also: {alsoMeans.join('; ')}
          </p>
        ) : null}

        {back.hskLabel ? <Badge tone="accent">{back.hskLabel}</Badge> : null}

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

        {showMasked && !revealed ? (
          <div className="w-full max-w-prose text-left">
            <p className="mb-1 text-xs tracking-wide text-muted uppercase">{context.label}</p>
            <ContextLine context={context} mode="masked" />
          </div>
        ) : null}
      </div>

      {revealed ? (
        <div data-testid="card-back" className="space-y-4 border-t border-border px-4 py-5 sm:px-5">
          <div className="flex flex-col items-center gap-2 text-center">
            <h2 data-testid="production-answer" className="hanzi text-6xl font-medium sm:text-7xl">
              {face.primary}
            </h2>
            {face.secondary ? (
              <p className="hanzi text-2xl text-muted">
                <span className="sr-only">{face.secondaryLabel}: </span>
                {face.secondary}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <p data-testid="card-pinyin" className="text-xl font-medium text-accent">
                {back.pinyinMarked}
              </p>
              <SpeakButton text={face.primary} label={face.primary} />
            </div>
          </div>

          {back.en ? (
            <p data-testid="card-en" className="text-base">
              {back.en}
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
              <span className="hanzi text-foreground">{back.classifiers.join(' · ')}</span>
            </p>
          ) : null}

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
