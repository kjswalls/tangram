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
import { useEffect, useState } from 'react';

import { Attribution } from '@/app/settings/attribution';
import { SettingsForm } from '@/app/settings/settings-form';
import { ListsView } from '@/components/lists/lists-view';
import { LearnerLevel } from '@/components/settings/learner-level';
import { StatsView } from '@/components/stats/stats-view';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { getRepository } from '@/lib/db/get-db';
import type { SettingsRow } from '@/lib/db/schema';

/** The Study card's id, so "Change" has somewhere to go. */
const STUDY_SECTION = 'library-study';

export function LibraryScreen({ attribution }: { attribution: string }) {
  /**
   * The learner level line (docs/plans/core.md C8). It reads the same two
   * fields the controls in the Study card write, live, so pressing Change and
   * moving the dropdown updates the sentence without a reload.
   */
  const [settings, setSettings] = useState<SettingsRow>();
  useEffect(() => {
    let cancelled = false;
    const repo = getRepository();
    const read = () => {
      repo.getSettings().then(
        (row) => {
          if (!cancelled) setSettings(row);
        },
        () => undefined,
      );
    };
    read();
    // The Study card writes through the repository, not through this
    // component, so the cheapest correct way to stay in step is to re-read when
    // the learner comes back to the page after changing something.
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', read);
    };
  }, []);

  return (
    <div data-testid="screen-library" className="flex flex-col gap-4">
      <PageHeader title="Library">
        Your lists, your texts, how it is going, and your settings.
      </PageHeader>

      <ListsView />

      <StatsView />

      <Card title="Study" id={STUDY_SECTION}>
        <SettingsForm onSettings={setSettings} />
      </Card>

      {/*
        **Your level** (docs/plans/core.md C8), at the bottom of Library as the
        plan places it. The HSK band model is unchanged; this is its
        presentation, and Change goes to the controls above rather than being a
        second way to write the same field.
      */}
      {settings ? (
        <Card title="Your level">
          <LearnerLevel
            settings={settings}
            onChange={() =>
              document.getElementById(STUDY_SECTION)?.scrollIntoView({ behavior: 'smooth' })
            }
          />
        </Card>
      ) : null}

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
