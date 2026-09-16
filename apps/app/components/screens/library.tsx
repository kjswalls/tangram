'use client';

/**
 * The **Library** tab (docs/plans/core.md C7; product-decisions §1).
 *
 * The shelf: lists, how it is going, and the settings — `/lists`, `/stats` and
 * `/settings` as one destination. Four of the seven routes were things a
 * learner visits occasionally and none of them is a verb, which is why they are
 * one tab rather than four.
 *
 * C8 rewrites what is on it: the panels get plain-English names, the learner
 * level appears at the bottom, the pinyin control gets its first surface, and
 * the optimizer becomes **absent** below 1,000 scorable reviews rather than a
 * disabled button. This phase re-homes them.
 *
 * It imports nothing from `components/shell/**` and nothing from the router.
 * The list *cards* below it still render real `<Link>`s, deliberately: a list
 * is a page a learner may want to open in a new tab, and C7's rule is about the
 * screen boundary. Recorded in HANDOFF.md.
 */
import { Attribution } from '@/app/settings/attribution';
import { SettingsForm } from '@/app/settings/settings-form';
import { ListsView } from '@/components/lists/lists-view';
import { StatsView } from '@/components/stats/stats-view';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';

export function LibraryScreen({ attribution }: { attribution: string }) {
  return (
    <div data-testid="screen-library" className="flex flex-col gap-4">
      <PageHeader title="Library">
        Your lists, your texts, how it is going, and your settings.
      </PageHeader>

      <ListsView />

      <StatsView />

      <Card title="Study">
        <SettingsForm />
      </Card>

      {/*
        Rendering `data/ATTRIBUTION.md` is a licence obligation, not a nicety
        (CLAUDE.md, "Data and licences"). It moved with `/settings` and it is
        still on screen.
      */}
      <Card title="Licenses">
        <Attribution source={attribution} />
      </Card>
    </div>
  );
}
