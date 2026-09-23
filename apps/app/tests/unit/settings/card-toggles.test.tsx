/**
 * The two card toggles (PLAN.md §4, Phase 6 items 1 and 2).
 *
 * They are ordinary settings fields, and the point of the two cases below is
 * the pair of decisions around them: they are **optional** on `SettingsRow`,
 * because a row written before they existed does not carry them and
 * `getSettings` returns the stored row as it stands; and adding them needed no
 * Dexie version bump, because `settings` indexes `id` and nothing else.
 */
import { fireEvent, render, screen, waitFor } from '../render';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsForm } from '@/app/settings/settings-form';
import { closeDb, getDb, getRepository } from '@/lib/db/get-db';
import { DB_VERSION, DEFAULT_SETTINGS, STORES, STORES_V1 } from '@/lib/db/schema';

afterEach(async () => {
  vi.unstubAllGlobals();
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

/**
 * Both toggles switch on a model-backed feature, so a build with no API
 * (`API_CONFIGURED` false: production, `VITE_API_BASE` empty) does not offer
 * them. A build whose API is merely down right now still does — that state is
 * transient, and the form is not the place to discover it.
 */
describe('the card toggles and the API', () => {
  it('are not offered on a build with no API, and the rest of the form is', async () => {
    render(<SettingsForm apiConfigured={false} />);
    // The form has loaded: a field that is not an AI toggle is there.
    expect(await screen.findByTestId('settings-new-per-day')).toBeInTheDocument();
    expect(screen.getByTestId('settings-short-term-steps')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-card-toggles')).toBeNull();
    expect(screen.queryByTestId('settings-examples-on-back')).toBeNull();
    expect(screen.queryByTestId('settings-free-recall')).toBeNull();
    // The section's heading goes with them: a heading over nothing is not a section.
    expect(screen.queryByText('On a card')).toBeNull();
  });

  it('are offered when an API is configured, even while it cannot be reached', async () => {
    // Every request refuses, as a browser's fetch does for a dead origin. The
    // form asks nobody, so it has no way to know — and must not need one.
    const refused = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', refused);
    render(<SettingsForm apiConfigured />);
    expect(await screen.findByTestId('settings-examples-on-back')).toBeInTheDocument();
    expect(screen.getByTestId('settings-free-recall')).toBeInTheDocument();
    expect(refused).not.toHaveBeenCalled();
  });

  it('are offered by default outside a production build', async () => {
    // Vitest is not a production build, so `API_CONFIGURED` is true here — the
    // default the Library screen renders with.
    render(<SettingsForm />);
    expect(await screen.findByTestId('settings-free-recall')).toBeInTheDocument();
  });
});
