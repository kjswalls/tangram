/**
 * `data.md` D6, acceptance criterion 5 — **the app boots with no dictionary and
 * shows `absent` rather than throwing** — met literally, which it could not be
 * until the gate stopped downloading on mount.
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
 * ## What changed
 *
 * D6 could only half-meet the criterion. `absent` is the state *before*
 * `open()`, `useDictStatus` called `open()` on mount, and since D6 that meant
 * *download the artifact* — so the settled no-dictionary screen was `failed`
 * and the `absent` card (the one carrying the size and a "Get it" button,
 * which `components/dict/dict-status.tsx` says exists because "a silent 14 MB
 * download on a metered connection is a hostile default") was unreachable.
 * This file's third case used to **pin** that: it asserted the first observable
 * frame was already `preparing` and that `dict-start` was not rendered.
 *
 * The mount is `openStored()` now, so the third case is its opposite — the gate
 * settles in `absent` and renders the ask — and a fourth says what the ask is
 * for: pressing it is what downloads, and nothing else does.
 *
 * **"Settles" is load-bearing in both.** A probe fetches nothing and reports
 * nothing, so while it runs the status is the `absent` it started in; the gate
 * holds the space and draws nothing until the probe answers, because otherwise a
 * learner who *has* the dictionary would see the ask flash at them on every
 * mount. That is why these wait rather than reading the first frame.
 */
import userEvent from '@testing-library/user-event';
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
 * other line — the initial status, `subscribe`, what an open does to the status
 * before its runner answers — is the shipped one.
 */
function unopened(): SqliteDictStore {
  return new SqliteDictStore({ connect: () => new Promise(() => {}) });
}

/**
 * **No `opener` prop anywhere below.** The gate resolves its own through
 * `getDictOpener()`, and in a jsdom test that has built no wasm handle the
 * answer is the fallback: `openStored()` does nothing, `download()` is the
 * store's `open()`. That is the production wiring for any store this module did
 * not build, so the cases below exercise the real resolution rather than a
 * stand-in that could agree with a gate that had never been fixed.
 */

describe('the gate over a dictionary that is not there', () => {
  it('starts in `absent`, before anything has opened it', () => {
    // Read off the store rather than the markup, so a gate that swallowed the
    // state could not make this pass. This is the half of criterion 5 that the
    // literal and the fake could never have checked.
    expect(unopened().status).toEqual({ state: 'absent' });
  });

  it('renders a banner instead of throwing, and withholds what it gates', async () => {
    const store = unopened();
    // Mounting runs the gate's effect. A store or opener that threw on the way
    // to the first frame — synchronously, or out of `subscribe` — would fail
    // here rather than blanking a fresh install's Look up tab, which is what "a
    // banner, not a crash" means in one assertion.
    render(
      <DictGate store={store}>
        <div data-testid="lookup" />
      </DictGate>,
    );

    expect(screen.getByTestId('dict-gate')).toBeTruthy();
    expect(await screen.findByTestId('dict-status')).toBeTruthy();
    // The gated surface is not offered, rather than offered and broken.
    expect(screen.queryByTestId('lookup')).toBeNull();
  });

  it('settles in `absent` and asks, rather than downloading unannounced', async () => {
    const store = unopened();
    expect(store.status.state).toBe('absent');

    render(
      <DictGate store={store}>
        <div data-testid="lookup" />
      </DictGate>,
    );

    // While the probe is out the gate holds the space and says nothing: the ask
    // is an answer, and there is not one yet.
    expect(screen.getByTestId('dict-gate').getAttribute('data-checking')).toBe('true');
    expect(screen.queryByTestId('dict-status')).toBeNull();

    // The criterion, literally: a boot with no dictionary settles on `absent`…
    const status = await screen.findByTestId('dict-status');
    expect(screen.getByTestId('dict-gate').getAttribute('data-state')).toBe('absent');
    expect(screen.getByTestId('dict-gate').getAttribute('data-checking')).toBeNull();
    // …which is the card with the size on it, and the button that is the only
    // production path to a download.
    expect(status.getAttribute('data-state')).toBe('absent');
    expect(screen.getByTestId('dict-start')).toBeTruthy();
  });

  it('downloads when the ask is accepted, and not before', async () => {
    const user = userEvent.setup();
    const store = unopened();

    render(
      <DictGate store={store}>
        <div data-testid="lookup" />
      </DictGate>,
    );
    const start = await screen.findByTestId('dict-start');

    // A mount is not a download. This is the defect in one assertion: before
    // this branch the store was already `preparing` here and there was no
    // button to press.
    expect(store.status.state).toBe('absent');

    await user.click(start);

    // The press reached the store's `open()` — the connection is pending, so
    // what the gate draws now is the progress it used to draw on mount.
    expect(store.status.state).toBe('preparing');
    expect(screen.getByTestId('dict-gate').getAttribute('data-state')).toBe('preparing');
  });
});
