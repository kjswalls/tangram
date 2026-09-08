'use client';

/**
 * "Add the reverse" — the per-card way to start producing a word you can
 * already read (Phase 8, builder B).
 *
 * It sits on the **back** of a recognition card, where the learner has just
 * seen the meaning and knows whether they could have written it. That is the
 * moment the decision is real, and it is a decision: production cards are never
 * created by a setting. `settings.productionDirection` decides whether this
 * control is offered at all; pressing it is what makes the card.
 *
 * One press, one card. It goes through `addCardFromEntry(..., 'production')`,
 * which is idempotent per (entryId, senseIndex, direction), so a double click
 * cannot make two — and the entry is rebuilt from the card's own snapshot
 * (`entryFromSnapshot`), so this works with no network and against the
 * dictionary the card was actually cut from.
 *
 * Unlike the per-list toggle this does not spend the day's new-card allowance.
 * It is an explicit add, and §3.3's rule for those has always been that they
 * bypass the cap: the cap exists to stop the *spine* introducing more than the
 * learner asked for, not to overrule what they asked for by hand.
 *
 * That is a claim about **provenance**, and it has to be written down to be
 * true: the twin is created with `source: 'reverse'`, which `isExplicitAdd`
 * (lib/lists/queue.ts) counts as a hand add. Inheriting the parent's source
 * instead — and every spine-drawn card carries `list` — made each press quietly
 * take one of the day's ten new words, on this day and again on the next while
 * the twin sat ungraded.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { getRepository } from '@/lib/db/get-db';
import type { Repository } from '@/lib/db/repository';
import type { CardRow } from '@/lib/db/schema';
import { entryFromSnapshot, PRODUCTION, twinContext, wordSnapshot } from '@/lib/srs/direction';

type Phase = 'unknown' | 'absent' | 'adding' | 'present' | 'failed';

export interface AddReverseProps {
  card: CardRow;
  /** Injected by tests; production reads the repository. */
  repo?: Repository;
}

export function AddReverse({ card, repo }: AddReverseProps) {
  const [phase, setPhase] = useState<Phase>('unknown');
  const snapshot = wordSnapshot(card.snapshot);
  const entryId = card.entryId;

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await (repo ?? getRepository()).cardForEntry(
          entryId,
          card.senseIndex,
          PRODUCTION,
        );
        if (!cancelled) setPhase(found ? 'present' : 'absent');
      } catch {
        // The question "is there already a reverse?" could not be answered.
        // Offering the button anyway is safe — the write is idempotent.
        if (!cancelled) setPhase('absent');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entryId, card.senseIndex, repo]);

  if (!snapshot || !entryId) return null;

  const add = async () => {
    setPhase('adding');
    try {
      const now = Date.now();
      await (repo ?? getRepository()).addCardFromEntry(
        entryFromSnapshot(entryId, snapshot),
        twinContext(card, now, 'reverse'),
        card.senseIndex,
        snapshot.dictVersion,
        PRODUCTION,
      );
      setPhase('present');
    } catch {
      setPhase('failed');
    }
  };

  return (
    <div data-testid="add-reverse" data-phase={phase} className="text-sm">
      {phase === 'present' ? (
        <p className="text-muted">
          Reverse card added — you will be asked to write this one from its meaning.
        </p>
      ) : (
        <>
          <Button
            data-testid="add-reverse-button"
            variant="ghost"
            size="sm"
            disabled={phase === 'adding' || phase === 'unknown'}
            onClick={() => void add()}
          >
            {phase === 'adding' ? 'Adding…' : 'Add the reverse'}
          </Button>
          {phase === 'failed' ? (
            <span className="ml-2 text-warning">That did not save — try again.</span>
          ) : null}
        </>
      )}
    </div>
  );
}
