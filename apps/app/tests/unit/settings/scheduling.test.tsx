/**
 * The three scheduling controls (Phase 8 prep): target retention, the
 * short-term learning steps, and the production direction.
 *
 * They are ordinary settings fields written straight through, like everything
 * else in this form. What is worth a test is the pair of facts around them:
 * the defaults are the ones the app actually ships with (and `shortTermSteps`
 * defaults **on**, undoing v1's deviation from ts-fsrs), and a row written
 * before any of them existed reads back as the default rather than as `false`
 * or a blank control.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsForm } from '@/app/settings/settings-form';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { DEFAULT_SETTINGS, STORES, STORES_V1 } from '@/lib/db/schema';
import { RETENTION_CHOICES } from '@/lib/srs/params';

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

describe('the scheduling settings', () => {
  it('start at the defaults this build ships', async () => {
    render(<SettingsForm />);
    const retention = (await screen.findByTestId('settings-request-retention')) as HTMLSelectElement;
    expect(retention.value).toBe(String(DEFAULT_SETTINGS.requestRetention));
    expect(screen.getByTestId('settings-short-term-steps')).toBeChecked();
    expect(screen.getByTestId('settings-production-direction')).not.toBeChecked();
    expect(DEFAULT_SETTINGS.requestRetention).toBe(0.9);
    expect(DEFAULT_SETTINGS.shortTermSteps).toBe(true);
    expect(DEFAULT_SETTINGS.productionDirection).toBe(false);
  });

  it('says which parameters are in force, and does not claim a fit it has not got', async () => {
    render(<SettingsForm />);
    expect(await screen.findByTestId('settings-fsrs-source')).toHaveTextContent('FSRS defaults');
  });

  it('offers the whole range, and writes each change straight through', async () => {
    render(<SettingsForm />);
    const retention = (await screen.findByTestId('settings-request-retention')) as HTMLSelectElement;
    expect([...retention.options].map((option) => Number(option.value))).toEqual([
      ...RETENTION_CHOICES,
    ]);

    fireEvent.change(retention, { target: { value: '0.95' } });
    await waitFor(async () => {
      expect((await getRepository().getSettings()).requestRetention).toBe(0.95);
    });

    fireEvent.click(screen.getByTestId('settings-short-term-steps'));
    await waitFor(async () => {
      expect((await getRepository().getSettings()).shortTermSteps).toBe(false);
    });

    fireEvent.click(screen.getByTestId('settings-production-direction'));
    await waitFor(async () => {
      expect((await getRepository().getSettings()).productionDirection).toBe(true);
    });

    // Three controls, three columns: none of them is the same switch twice.
    const settings = await getRepository().getSettings();
    expect(settings.requestRetention).toBe(0.95);
    expect(settings.shortTermSteps).toBe(false);
    expect(settings.productionDirection).toBe(true);
  });

  it('reads a row saved before the columns existed as the defaults', async () => {
    const now = Date.now();
    const legacy = { ...DEFAULT_SETTINGS, createdAt: now, updatedAt: now } as Record<
      string,
      unknown
    >;
    delete legacy.requestRetention;
    delete legacy.shortTermSteps;
    delete legacy.productionDirection;
    delete legacy.fsrsWeights;
    await getDb().settings.put(legacy as never);

    render(<SettingsForm />);
    const retention = (await screen.findByTestId('settings-request-retention')) as HTMLSelectElement;
    // Not a blank select: `getSettings` fills the column in on the way out.
    expect(retention.value).toBe(String(DEFAULT_SETTINGS.requestRetention));
    expect(screen.getByTestId('settings-short-term-steps')).toBeChecked();
    expect(screen.getByTestId('settings-production-direction')).not.toBeChecked();
  });

  it('needed no Dexie version of its own: the settings store indexes the key alone', () => {
    // v3 exists for an index on `cards`, not for these. IndexedDB does not
    // police the shape of a row whose key path it does not index.
    expect(STORES_V1.settings).toBe('id');
    expect(STORES.settings).toBe(STORES_V1.settings);
  });
});
