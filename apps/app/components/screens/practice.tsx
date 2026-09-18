'use client';

/**
 * The **Practice** tab (docs/plans/core.md C7; `wave-zero.md` §9).
 *
 * **One session.** product-decisions §1's central claim is that learning a new
 * word, recognising it and writing it are one thing, and until C7 they were
 * three: the day's new words were introduced by *opening Today*, and the
 * session then served whatever `buildQueue` returned on a different screen,
 * reviews first and new words after all of them.
 *
 * What makes it one session is in three places and none of them is this file:
 * `lib/lists/today.ts` still owns the draw and the day's charge,
 * `lib/srs/session.ts`'s `interleaveNew` spreads the new words through the due
 * ones, and `lib/stores/review.ts` is the only caller that introduces. This
 * screen is where all of it is reached, and — since `components/screens/today.tsx`
 * stopped introducing — **the only place it is reached**.
 *
 * C8 mounts the tangram pieces here.
 */
import { ReviewSession } from '@/components/review/review-session';
import { PageHeader } from '@/components/ui/page-header';

export function PracticeScreen() {
  return (
    <div data-testid="screen-practice" className="flex flex-col gap-4">
      <PageHeader title="Practice">
        New words, the ones you are recognising, and the ones you write from memory — in one go.
      </PageHeader>
      <ReviewSession />
    </div>
  );
}
