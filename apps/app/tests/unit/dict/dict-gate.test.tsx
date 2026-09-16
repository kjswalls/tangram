/**
 * `data.md` D6, acceptance criterion 5 — **the app boots with no dictionary and
 * says so rather than throwing** — and the one place where the fact that the
 * criterion is only half met is written down as a failing-if-changed assertion
 * rather than as prose.
 *
 * > A test asserts the app boots with **no** dictionary present and shows the
 * > `absent` state rather than throwing — the missing-data banner's successor,
 * > and the same promise CLAUDE.md makes today ("missing data is a banner, not
 * > a crash").
 *
 * Everything that asserted `absent` before this file asserted it about
 * something that is not the app's dictionary: `dict-status.test.tsx` hands
 * `DictStatusView` a **literal**, and `tests/e2e/core/dict-states.spec.ts`
 * drives `components/gallery/fake-dict-store.ts`, a **hand-written fake**.
 * Neither can fail if `SqliteDictStore` starts in the wrong state or throws on
 * its way to the first render.
 *
 * ## What is met, and what is not
 *
 * **Met:** the app does not throw, and the learner is told. The settled
 * no-dictionary screen is `failed`, with a reason and a retry, asserted by
 * `tests/e2e/core/dict-states.spec.ts`'s "with the dictionary down" block and
 * by `tests/e2e/d/dict-offline.spec.ts`. That is a banner and not a crash,
 * which is the criterion's own gloss.
 *
 * **Not met:** the screen is not `absent`. `absent` is the state *before*
 * `open()`, and `useDictStatus` calls `open()` on mount — which since D6 means
 * *download the artifact*. So the `absent` card, the one carrying the size and
 * a "Get it" button that `components/dict/dict-status.tsx` says exists because
 * "a silent 14 MB download on a metered connection is a hostile default", is
 * unreachable in the running app. Not merely unlikely: the third case below
 * mounts the gate over a store that has never been opened and the first
 * observable frame is already `preparing`.
 *
 * That case is deliberately written as a **pin on a known defect**, not as an
 * endorsement. D6 did not fix it because the fix is a handful of lines here and
 * about 120 e2e tests everywhere else — that is how many open a gated route on
 * an origin with an empty OPFS, relying on the silent download — which is a
 * change neither D6 nor `core.md` C4a would be reviewed as. HANDOFF.md under D6 carries
 * the reasoning, the one-line fix and the machinery that is already built for
 * it (`WasmDictStoreHandle.openStored()` / `download()`). **Whoever spends that
 * line deletes the third case and un-skips the `absent` expectations in the
 * second.**
 */
import { describe, expect, it } from 'vitest';

import { DictGate } from '@/components/dict/dict-gate';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';

import { render, screen } from '../render';

/**
 * A real `SqliteDictStore` whose connection never arrives.
 *
 * `connect` is the store's one dependency and the only thing in it that needs a
 * platform, so a promise that never settles is a complete stand-in for "this
 * device has no dictionary yet": no OPFS, no `node:sqlite`, no 43 MB. Every
 * other line — the initial status, `subscribe`, what `open()` does to the
 * status before its runner answers — is the shipped one.
 */
function unopened(): SqliteDictStore {
  return new SqliteDictStore({ connect: () => new Promise(() => {}) });
}

describe('the gate over a dictionary that is not there', () => {
  it('starts in `absent`, before anything has opened it', () => {
    // Read off the store rather than the markup, so a gate that swallowed the
    // state could not make this pass. This is the half of criterion 5 that the
    // literal and the fake could never have checked.
    expect(unopened().status).toEqual({ state: 'absent' });
  });

  it('renders a banner instead of throwing, and withholds what it gates', () => {
    const store = unopened();
    // Mounting runs the gate's effect, which calls `open()`. A store that threw
    // on the way to the first frame — synchronously out of `open()`, or out of
    // `subscribe` — would fail here rather than blanking a fresh install's Look
    // up tab, which is what "a banner, not a crash" means in one assertion.
    render(
      <DictGate store={store}>
        <div data-testid="lookup" />
      </DictGate>,
    );

    expect(screen.getByTestId('dict-gate')).toBeTruthy();
    expect(screen.getByTestId('dict-status')).toBeTruthy();
    // The gated surface is not offered, rather than offered and broken.
    expect(screen.queryByTestId('lookup')).toBeNull();
  });

  it('PINS THE DEFECT: mounting leaves `absent` at once, so the ask never shows', () => {
    const store = unopened();
    expect(store.status.state).toBe('absent');

    render(
      <DictGate store={store}>
        <div data-testid="lookup" />
      </DictGate>,
    );

    // Not `absent`. The mount-time `open()` has already moved it, and on the
    // web that means a download the learner was never asked about.
    expect(screen.getByTestId('dict-gate').getAttribute('data-state')).toBe('preparing');
    // …so the card with the size on it, and its "Get it" button, is not what a
    // first visit renders. `dict-start` has no production path that reaches it.
    expect(screen.queryByTestId('dict-start')).toBeNull();
  });
});
