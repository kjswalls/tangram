'use client';

/**
 * The **Look up** tab (docs/plans/core.md C7; product-decisions §1).
 *
 * The dictionary, the AI answer and the pasted texts, which used to be `/`,
 * `/lookup` and `/read`. One box, no mode picker (PLAN.md §1): the routing
 * decision lives in `lib/dict/search.ts` and the screen never asks the learner
 * what kind of thing they typed.
 *
 * **The box leads the screen and Today is stated beneath it** (§1's layout
 * facts, and C8's "Today is a sentence"). That ordering is the product decision
 * that the most prominent thing on the home screen should be the thing a
 * learner came to do, not a count of what they owe.
 *
 * It imports nothing from `components/shell/**` and nothing from the router —
 * C7's rule — so it renders the same inside either shell, and the one thing it
 * needs from outside is `useScreenNavigate()`.
 */
import { useScreenNavigate } from '@/components/screens/navigate';
import { TodayView } from '@/components/screens/today';
import { DictGate } from '@/components/dict/dict-gate';
import { LookupView } from '@/components/lookup/lookup-view';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export function LookUpScreen() {
  const go = useScreenNavigate();
  return (
    <div data-testid="screen-lookup" className="flex flex-col gap-4">
      <PageHeader title="Look up">Hanzi, pinyin or English — one box, no mode picker.</PageHeader>

      <DictGate>
        <LookupView />
      </DictGate>

      <TodayView />

      {/*
        The pasted-text reader, which used to be its own nav entry. It keeps a
        path (`/read`) because a text is a place a learner comes back to, but it
        is a region of this tab rather than a fourth destination.
      */}
      <Card title="Your own texts">
        <p className="text-sm text-muted">
          Paste anything — a chat message, a menu, a paragraph — and tap a word to look it up in
          its own sentence. What you add keeps that sentence.
        </p>
        <div className="mt-3">
          <Button
            variant="secondary"
            data-testid="open-texts"
            onClick={() => go({ tab: 'lookup', view: 'texts' })}
          >
            Open a text
          </Button>
        </div>
      </Card>
    </div>
  );
}
