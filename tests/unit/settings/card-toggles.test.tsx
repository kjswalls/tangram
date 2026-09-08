/**
 * The two card toggles (PLAN.md §4, Phase 6 items 1 and 2).
 *
 * They are ordinary settings fields, and the point of the two cases below is
 * the pair of decisions around them: they are **optional** on `SettingsRow`,
 * because a row written before they existed does not carry them and
 * `getSettings` returns the stored row as it stands; and adding them needed no
 * Dexie version bump, because `settings` indexes `id` and nothing else.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsForm } from '@/app/settings/settings-form';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { DB_VERSION, DEFAULT_SETTINGS, STORES, STORES_V1 } from '@/lib/db/schema';

afterEach(async () => {
  await getDb().delete();
  await closeDb();
});

describe('the card toggles', () => {
  it('start at the documented defaults: sentences on, recall box off', async () => {
    render(<SettingsForm />);
    const examples = await screen.findByTestId('settings-examples-on-back');
    const recall = screen.getByTestId('settings-free-recall');

    expect(examples).toBeChecked();
    expect(recall).not.toBeChecked();
    expect(DEFAULT_SETTINGS.examplesOnBack).toBe(true);
    expect(DEFAULT_SETTINGS.freeRecall).toBe(false);
  });

  it('writes each change straight through, like every other setting here', async () => {
    render(<SettingsForm />);
    fireEvent.click(await screen.findByTestId('settings-free-recall'));
    await waitFor(async () => {
      expect((await getRepository().getSettings()).freeRecall).toBe(true);
    });

    fireEvent.click(screen.getByTestId('settings-examples-on-back'));
    await waitFor(async () => {
      expect((await getRepository().getSettings()).examplesOnBack).toBe(false);
    });
    // The one that was already on stays on: two toggles, not one.
    expect((await getRepository().getSettings()).freeRecall).toBe(true);
  });

  it('reads a row saved before the fields existed as the default, not as off', async () => {
    // What an existing browser holds: a settings row with neither key.
    const now = Date.now();
    const legacy = { ...DEFAULT_SETTINGS, createdAt: now, updatedAt: now } as Record<string, unknown>;
    delete legacy.examplesOnBack;
    delete legacy.freeRecall;
    await getDb().settings.put(legacy as never);

    render(<SettingsForm />);
    expect(await screen.findByTestId('settings-examples-on-back')).toBeChecked();
    expect(screen.getByTestId('settings-free-recall')).not.toBeChecked();
  });

  it('needed no Dexie version bump: the settings store indexes the key alone', () => {
    // The version has since moved to 2 for an index on `lists` (the system-list
    // uniqueness fix), but the settings store's definition is untouched at both
    // versions — which is the fact these two fields relied on: IndexedDB does
    // not police the shape of a row whose key path it does not index.
    expect(STORES_V1.settings).toBe('id');
    expect(STORES.settings).toBe(STORES_V1.settings);
    expect(DB_VERSION).toBeGreaterThanOrEqual(1);
  });
});
