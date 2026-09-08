'use client';

/**
 * `/stats` — the retention dashboard (Phase 8).
 *
 * One read of the repository (`loadStats`), four panels off it. The view holds
 * no numbers of its own: anything a panel shows was derived in `lib/stats`,
 * where it is unit-tested, so a chart and its caption cannot disagree.
 *
 * Nothing here writes. Opening Today introduces cards and opening Review grades
 * them; a dashboard that changed the thing it measures would be its own worst
 * data source.
 */

import { useEffect, useState } from 'react';

import { CalibrationChart } from '@/components/stats/calibration-chart';
import { ChartTokens } from '@/components/stats/chart-tokens';
import { MaturityPanel } from '@/components/stats/maturity-panel';
import { RetentionPanel } from '@/components/stats/retention-panel';
import { WorkloadChart } from '@/components/stats/workload-chart';
import { Card } from '@/components/ui/card';
import { getRepository } from '@/lib/db/get-db';
import { loadStats, type StatsSummary } from '@/lib/stats/summary';

export function StatsView() {
  const [summary, setSummary] = useState<StatsSummary>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    loadStats({ repo: getRepository() })
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Card title="Stats">
        <p role="status" className="text-sm text-warning">
          {error}
        </p>
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card title="Stats">
        <p data-testid="stats-loading" className="text-sm text-muted">
          Reading your review log…
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ChartTokens />
      <RetentionPanel
        window={summary.retentionWindow}
        allTime={summary.retentionAllTime}
        windowDays={summary.windowDays}
      />
      <CalibrationChart summary={summary.calibration} parameters={summary.parameters} />
      <WorkloadChart
        past={summary.reviewsPerDay}
        forecast={summary.forecast}
        peak={summary.workloadPeak}
        windowDays={summary.windowDays}
      />
      <MaturityPanel states={summary.states} stability={summary.stability} known={summary.known} />
    </div>
  );
}
