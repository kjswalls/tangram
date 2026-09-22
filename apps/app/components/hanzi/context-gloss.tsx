'use client';

/**
 * The in-context gloss line (docs/plans/core.md C4; product-decisions §5).
 *
 * One line, under the headword, on what the word means **in the sentence the
 * learner met it in** — the disambiguation a beginner cannot do alone, and the
 * reason a tap in a passage is worth more than a dictionary lookup.
 *
 * **It is model output over a cited entry, so it obeys the grounding contract
 * like everything else** (CLAUDE.md, PLAN.md §3.4). The model returns an entry
 * id and a sense index; this component renders the sense *from the entry*, so:
 *
 *   - a match citing a different entry than the one on screen is dropped;
 *   - a sense index outside the entry's own senses is dropped;
 *   - the model's prose (`whyThisOne`) goes through `scrubProse` again — no
 *     hanzi, no readings, bounded. The route already scrubs it; this line sits
 *     directly under a headword, where a fabricated character beside a real one
 *     is the worst thing this product can print, so it is re-applied here
 *     rather than trusted.
 *
 * **Absent, not empty.** When there is no answer, no AI reachable, or nothing
 * survives the checks above, the component renders `null`. The senses and the
 * Add above it do not wait on this line and do not move when it arrives — the
 * slot is not reserved, because a reserved slot is a promise the offline case
 * cannot keep.
 */
import { useEffect, useState } from 'react';

import { scrubProse } from '@tangram/ai/ground';
import type { GroundedMatch } from '@tangram/ai/ground';
// The ask module (`backend.md` B2). This hook used to POST `/api/ask` itself;
// after the contract flip an ask is two round trips, a local retrieval and a
// local `ground()`, and none of that may exist twice.
import { ask } from '@/lib/ai/ask-client';
import { API_CONFIGURED } from '@/src/access/client';
import type { CardContext, Entry } from '@/lib/types';

export interface ContextGlossProps {
  /** The entry the sheet is showing. The line may only name one of its senses. */
  entry: Entry | undefined;
  /**
   * What the ask module answered for this word in this sentence, or undefined
   * when it has not answered or cannot. **C7 owns the ask module's state
   * shape**; this consumes it and adds no second wire contract.
   */
  match?: GroundedMatch | undefined;
}

/** The sense the match names, or undefined when it does not name one this entry has. */
export function citedSense(entry: Entry | undefined, match: GroundedMatch | undefined) {
  if (!entry || !match) return undefined;
  if (match.entryId !== entry.id) return undefined;
  if (!Number.isInteger(match.senseIndex)) return undefined;
  const gloss = entry.glosses[match.senseIndex];
  return gloss === undefined ? undefined : { gloss, index: match.senseIndex };
}

export function ContextGloss({ entry, match }: ContextGlossProps) {
  const sense = citedSense(entry, match);
  if (!sense) return null;

  const why = scrubProse(match?.whyThisOne ?? '').trim();

  return (
    <p
      data-testid="context-gloss"
      data-sense-index={sense.index}
      className="mt-2 rounded-[var(--r-sm)] bg-lookup-soft px-3 py-2 text-sm text-lookup"
    >
      <span className="font-medium">Here: </span>
      <span data-testid="context-gloss-sense">{sense.gloss}</span>
      {why ? <span className="text-ink/70"> — {why}</span> : null}
    </p>
  );
}

/**
 * Ask the module what this word means in this sentence.
 *
 * A thin call, not a second ask client — and after `backend.md` B2 that is
 * enforced rather than intended: it calls `ask()` and keeps the one `match`
 * that cites the entry on screen. It passes `cache: false`, because the panel
 * owns that key and its trustworthiness rules, and a second writer with a
 * simpler idea of when an answer is worth keeping is how a cache starts lying.
 * It still *reads* the cache, which is free and is the same answer.
 *
 * **What it gets for free by going through the module.** The match it keeps is
 * grounded: its `entryId` was in a retrieved set this device built and its
 * `senseIndex` is in range, so `citedSense` below is checking a second time
 * rather than for the first time. Before the flip that grounding happened on
 * the server; a hook that kept posting its own body would have been reading an
 * **ungrounded** answer and rendering a sense index off a model's word.
 *
 * Every failure renders nothing. The line is a bonus on top of a dictionary
 * entry that is already on screen, and the senses and the Add never wait on it.
 *
 * **With no API in this build it does not ask at all** — and still renders
 * nothing, which is a decision rather than an omission. The line has no slot
 * and no control (see "Absent, not empty" above), so there is nothing dead on
 * screen to explain; and it lives inside the reader, which is not an AI surface
 * and must not wait on, probe or mention the API. The Look up tab's ask panel is
 * where the learner is told AI is not set up. Recorded in `HANDOFF.md`.
 */
export function useContextGloss(
  query: string,
  context: CardContext | undefined,
): { match?: GroundedMatch } {
  const [answer, setAnswer] = useState<{ key: string; match?: GroundedMatch }>();

  const sentence = context?.sentence;
  const key = sentence ? [query, sentence].join('\u0000') : '';

  useEffect(() => {
    if (!key || !query || !sentence || !API_CONFIGURED) return;
    let cancelled = false;
    const controller = new AbortController();
    setAnswer({ key });

    void (async () => {
      try {
        const outcome = await ask(
          { query, ...(context ? { context } : {}) },
          { signal: controller.signal, cache: false },
        );
        if (cancelled) return;
        setAnswer({
          key,
          ...(outcome.state === 'answered' ? pickMatch(outcome.response.matches) : {}),
        });
      } catch {
        if (!cancelled) setAnswer({ key });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `context` is rebuilt on every render by the reader; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Nothing for this word in this sentence yet — including while a previous
  // word's answer is still in state, which must not be shown under a new one.
  if (!key || answer?.key !== key) return {};
  return answer.match === undefined ? {} : { match: answer.match };
}

/**
 * The first match, whichever entry it cites. `<ContextGloss>` drops it if it is
 * not the entry on screen — the check lives there, once, because the same rule
 * has to hold for a match supplied by any caller and not only by this hook.
 */
function pickMatch(matches: readonly GroundedMatch[]): { match?: GroundedMatch } {
  const [first] = matches;
  return first === undefined ? {} : { match: first };
}
