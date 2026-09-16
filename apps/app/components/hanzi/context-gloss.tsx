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

import type { AskRouteResponse } from '@/app/api/ask/route';
import { scrubProse } from '@/lib/ai/ground';
import type { GroundedMatch } from '@/lib/ai/ground';
import { getRepository } from '@/lib/db/get-db';
import { getLearnerProfile } from '@/lib/srs/profile';
import type { CardContext, Entry } from '@/lib/types';

// `apiFetch`, not `fetch` (docs/plans/web.md W4). It applies the configured
// API base and attaches `X-Tangram-Access`; without it this call 401s on any
// deployment with `TANGRAM_ACCESS_SECRET` set, and goes to the wrong origin
// once `backend.md` moves the route off this one.
import { apiFetch } from '@/src/access/client';

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
 * A thin call, not a second ask client: it posts the same `/api/ask` body the
 * panel posts — `{ query, context, profile }` — and keeps the one `match` that
 * cites the entry on screen. It deliberately does **not** write `ask_cache`:
 * the panel owns that key and its trustworthiness rules (`cacheable`, the
 * handshake, the provider), and a second writer with a simpler idea of when an
 * answer is worth keeping is how a cache starts lying. **C7 owns the ask
 * module's state; when it lands, this hook is what it replaces.**
 *
 * Every failure is `unavailable`, which renders nothing. The line is a bonus on
 * top of a dictionary entry that is already on screen, and the senses and the
 * Add never wait on it.
 */
export function useContextGloss(
  query: string,
  context: CardContext | undefined,
): { match?: GroundedMatch } {
  const [answer, setAnswer] = useState<{ key: string; match?: GroundedMatch }>();

  const sentence = context?.sentence;
  const key = sentence ? [query, sentence].join('\u0000') : '';

  useEffect(() => {
    if (!key || !query || !sentence) return;
    let cancelled = false;
    const controller = new AbortController();
    setAnswer({ key });

    void (async () => {
      try {
        const profile = await getLearnerProfile(getRepository());
        const res = await apiFetch('/api/ask', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ query, context, profile }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as AskRouteResponse;
        if (cancelled) return;
        setAnswer({ key, ...pickMatch(body.response.matches) });
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
