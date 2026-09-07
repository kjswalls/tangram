'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getRepository } from '@/lib/db/get-db';
import type { ScriptPreference, SettingsRow } from '@/lib/db/schema';
import { loadDemo, resetAll } from '@/lib/dev/seed';
import { HSK_BANDS, hskBandLabel, type HskBand } from '@/lib/types';

type Danger = 'demo' | 'reset';

const SELECT =
  'h-11 w-full rounded-lg border border-border bg-surface px-3 text-base focus:border-accent focus:outline-none';

/**
 * The five settings the queue and the reader actually read (§3.3), plus the two
 * buttons that make a demo out of an empty database and an empty database out of
 * a demo. Every change is written straight through — there is no Save button to
 * forget to press, and the queue reads the row, not this component.
 */
export function SettingsForm() {
  const [settings, setSettings] = useState<SettingsRow>();
  const [status, setStatus] = useState<string>();
  const [confirming, setConfirming] = useState<Danger>();
  const [pending, setPending] = useState<Danger>();

  useEffect(() => {
    void getRepository()
      .getSettings()
      .then(setSettings)
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  const patch = async (values: Partial<Omit<SettingsRow, 'id' | 'createdAt'>>) => {
    const next = await getRepository().setSettings(values);
    setSettings(next);
    setStatus('Saved');
  };

  const run = async (kind: Danger) => {
    setPending(kind);
    setStatus(undefined);
    try {
      if (kind === 'demo') {
        const summary = await loadDemo();
        setSettings(summary.settings);
        setStatus(`Demo loaded: ${summary.cards.length} cards, ${summary.knownCount} words known.`);
      } else {
        await resetAll();
        setSettings(await getRepository().getSettings());
        setStatus('Everything wiped.');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(undefined);
      setConfirming(undefined);
    }
  };

  if (!settings) {
    return <p className="text-sm text-muted">{status ?? 'Loading settings…'}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>New cards per day</span>
          <Input
            type="number"
            min={0}
            max={200}
            data-testid="settings-new-per-day"
            value={settings.newPerDay}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0) void patch({ newPerDay: value });
            }}
          />
          <span className="text-xs text-muted">Caps the spine draw. Words you add yourself are extra.</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>Spine starts at HSK</span>
          <select
            className={SELECT}
            data-testid="settings-spine-start-band"
            value={settings.spineStartBand}
            onChange={(event) => void patch({ spineStartBand: Number(event.target.value) as HskBand })}
          >
            {HSK_BANDS.map((band) => (
              <option key={band} value={band}>
                {hskBandLabel(band)}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">The first band the auto-draw takes new words from.</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>Assume known through HSK</span>
          <select
            className={SELECT}
            data-testid="settings-known-band"
            value={settings.knownBand}
            onChange={(event) => void patch({ knownBand: Number(event.target.value) as HskBand })}
          >
            {HSK_BANDS.map((band) => (
              <option key={band} value={band}>
                {hskBandLabel(band)}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">Words at or below this band read as known everywhere.</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>Day rolls over at</span>
          <Input
            type="number"
            min={0}
            max={23}
            data-testid="settings-day-rollover"
            value={settings.dayRollover}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= 23) void patch({ dayRollover: value });
            }}
          />
          <span className="text-xs text-muted">Local hour. 4 means 01:30 still counts as yesterday.</span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span>Script</span>
          <select
            className={SELECT}
            data-testid="settings-script"
            value={settings.script}
            onChange={(event) => void patch({ script: event.target.value as ScriptPreference })}
          >
            <option value="simp">Simplified</option>
            <option value="trad">Traditional</option>
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <p className="text-sm text-muted">
          The demo replaces everything in this browser with a worked example: HSK 1–2 known, eight cards
          carrying where they came from, a paragraph to read. You can also reach it at{' '}
          <Link href="/?seed=demo" className="text-accent underline underline-offset-2">
            /?seed=demo
          </Link>
          .
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            data-testid="load-demo"
            disabled={pending !== undefined}
            onClick={() => (confirming === 'demo' ? void run('demo') : setConfirming('demo'))}
          >
            {pending === 'demo' ? 'Loading…' : confirming === 'demo' ? 'Replace everything?' : 'Load demo'}
          </Button>
          <Button
            variant="secondary"
            data-testid="reset-all"
            disabled={pending !== undefined}
            onClick={() => (confirming === 'reset' ? void run('reset') : setConfirming('reset'))}
          >
            {pending === 'reset' ? 'Wiping…' : confirming === 'reset' ? 'Wipe everything?' : 'Reset all'}
          </Button>
          {confirming ? (
            <Button variant="ghost" onClick={() => setConfirming(undefined)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {status ? (
        <p role="status" data-testid="settings-status" className="text-sm text-muted">
          {status}
        </p>
      ) : null}
    </div>
  );
}
