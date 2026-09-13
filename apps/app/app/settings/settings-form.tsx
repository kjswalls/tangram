'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { OptimizerPanel } from '@/components/settings/optimizer-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getRepository } from '@/lib/db/get-db';
import { DEFAULT_SETTINGS, type ScriptPreference, type SettingsRow } from '@/lib/db/schema';
import { loadDemo, resetAll } from '@/lib/dev/seed';
import { describeParameters, RETENTION_CHOICES } from '@/lib/srs/params';
import { HSK_BANDS, hskBandLabel, type HskBand } from '@/lib/types';

type Danger = 'demo' | 'reset';

/** `0.9` → `90%`. Whole percents; every offered step is one. */
const percent = (value: number): string => `${Math.round(value * 100)}%`;

const SELECT =
  'h-11 w-full rounded-lg border border-border bg-surface px-3 text-base focus:border-accent focus:outline-none';

/**
 * The settings the queue, the reader and the review card actually read (§3.3,
 * and Phase 6 items 1 and 2 for the two card toggles), plus the two
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

  /**
   * A number field commits what the learner can actually have: the field's own
   * min/max. Typing 300 into a field that says max 200 used to store 300, and
   * clearing the field used to store 0 and report "Saved" — an empty box is a
   * half-typed number, not a decision to stop drawing new cards.
   */
  const commitNumber = (
    raw: string,
    min: number,
    max: number,
    apply: (value: number) => Partial<Omit<SettingsRow, 'id' | 'createdAt'>>,
  ) => {
    if (raw.trim() === '') return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    void patch(apply(Math.min(max, Math.max(min, Math.trunc(value)))));
  };

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

  // A row written before Phase 8 has no retention of its own — `getSettings`
  // fills the column in, and this is the belt to that's braces. A stored value
  // that is not one of the offered steps (the optimizer could write one) is
  // added to the list rather than left showing an empty select.
  const retention = settings.requestRetention ?? DEFAULT_SETTINGS.requestRetention;
  const retentionChoices = RETENTION_CHOICES.includes(retention)
    ? RETENTION_CHOICES
    : [...RETENTION_CHOICES, retention].sort((a, b) => a - b);

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
            onChange={(event) =>
              commitNumber(event.target.value, 0, 200, (newPerDay) => ({ newPerDay }))
            }
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
            onChange={(event) =>
              commitNumber(event.target.value, 0, 23, (dayRollover) => ({ dayRollover }))
            }
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

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <p className="text-sm tracking-wide text-muted uppercase">Scheduling</p>

        <label className="flex flex-col gap-1 text-sm sm:max-w-sm">
          <span>Target retention</span>
          <select
            className={SELECT}
            data-testid="settings-request-retention"
            value={retention}
            onChange={(event) => void patch({ requestRetention: Number(event.target.value) })}
          >
            {retentionChoices.map((value) => (
              <option key={value} value={value}>
                {percent(value)}
                {value === DEFAULT_SETTINGS.requestRetention ? ' — FSRS default' : ''}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">
            How much you aim to remember when a card comes back. Higher means more reviews and
            better retention; lower means fewer reviews and more forgetting.
          </span>
          <span data-testid="settings-fsrs-source" className="text-xs text-muted">
            {describeParameters(settings)}
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              data-testid="settings-short-term-steps"
              checked={settings.shortTermSteps ?? DEFAULT_SETTINGS.shortTermSteps}
              onChange={(event) => void patch({ shortTermSteps: event.target.checked })}
            />
            Short steps for new and failed cards
          </span>
          <span className="text-xs text-muted">
            A card you get wrong comes back in about ten minutes instead of tomorrow. Turn it off
            to make every card wait at least a day.
          </span>
        </label>

        {/* The optimizer (Phase 8 item 3). It writes `fsrsWeights` through the
            same repository call the rest of this form does, and hands back the
            row it wrote so the source line above stays in step. */}
        <OptimizerPanel settings={settings} onSettings={setSettings} />

        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              data-testid="settings-production-direction"
              checked={settings.productionDirection ?? DEFAULT_SETTINGS.productionDirection}
              onChange={(event) => void patch({ productionDirection: event.target.checked })}
            />
            Also practise the other direction
          </span>
          <span className="text-xs text-muted">
            English on the front, the hanzi recalled. A second card per word, with its own
            schedule — it roughly doubles how much there is to review. Turning it off stops the
            reverse cards you have already made from being asked; nothing is deleted, and they come
            back with the schedule they earned if you turn it on again.
          </span>
        </label>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <p className="text-sm tracking-wide text-muted uppercase">On a card</p>

        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              data-testid="settings-examples-on-back"
              // A row written before this field existed carries neither
              // toggle, and `undefined` there means "not decided", not "off".
              checked={settings.examplesOnBack ?? DEFAULT_SETTINGS.examplesOnBack ?? true}
              onChange={(event) => void patch({ examplesOnBack: event.target.checked })}
            />
            Example sentences on the back
          </span>
          <span className="text-xs text-muted">
            Sentences built from words you already know, with the card&rsquo;s word in them.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              data-testid="settings-free-recall"
              checked={settings.freeRecall ?? DEFAULT_SETTINGS.freeRecall ?? false}
              onChange={(event) => void patch({ freeRecall: event.target.checked })}
            />
            Type the meaning before flipping
          </span>
          <span className="text-xs text-muted">
            Adds a box to the front of the card. Nothing is ever graded for you &mdash; the
            suggestion is a highlighted button you can ignore.
          </span>
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
