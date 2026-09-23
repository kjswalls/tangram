/**
 * The dictionary's four states, as markup (docs/plans/core.md C1; C4a wires
 * them to the real store).
 *
 * The assertions that matter are the ones that would otherwise be "a bar
 * exists": `preparing` must be DETERMINATE when `received`/`total` are there,
 * the four failure reasons must be four different screens, and `ready` must
 * render nothing at all.
 */
import { describe, expect, it, vi } from 'vitest';

import { DictStatusView } from '@/components/dict/dict-status';
import type { DictStatus } from '@/lib/dict/store';

import { render, screen } from '../render';

const REASONS = ['download', 'import', 'storage', 'corrupt'] as const;

describe('DictStatusView', () => {
  it('renders nothing when the dictionary is ready', () => {
    const { container } = render(<DictStatusView status={{ state: 'ready', version: '1' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('asks explicitly, with the size in it, when the dictionary is absent', () => {
    const onStart = vi.fn();
    render(<DictStatusView status={{ state: 'absent' }} onStart={onStart} />);
    const card = screen.getByTestId('dict-status');
    expect(card.getAttribute('data-state')).toBe('absent');
    // A silent 14 MB download on a metered connection is a hostile default.
    expect(card.textContent).toMatch(/\d+\s?MB/);
    expect(screen.getByTestId('dict-start')).toBeTruthy();
  });

  it('shows a DETERMINATE bar while preparing, driven by received/total', () => {
    render(<DictStatusView status={{ state: 'preparing', received: 7_000_000, total: 14_000_000 }} />);
    const bar = screen.getByTestId('dict-progress-bar');
    expect(screen.getByTestId('dict-progress').getAttribute('data-determinate')).toBe('true');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('7000000');
    expect(bar.getAttribute('aria-valuemax')).toBe('14000000');
    // The fill is a real width, not a class that might be anything.
    expect(screen.getByTestId('dict-progress-fill').getAttribute('style')).toContain('width: 50%');
    expect(screen.getByTestId('dict-progress').textContent).toContain('50%');
  });

  it('omits aria-valuenow when indeterminate, which is how a reader says "unknown"', () => {
    render(<DictStatusView status={{ state: 'preparing' }} />);
    const bar = screen.getByTestId('dict-progress-bar');
    expect(screen.getByTestId('dict-progress').getAttribute('data-determinate')).toBe('false');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('aria-valuemax')).toBeNull();
    // …and it moves, rather than sitting at what looks like 0%.
    expect(screen.getByTestId('dict-progress-fill').className).toContain('animate-[dict-sweep');
    expect(screen.getByTestId('dict-progress-fill').className).toContain('motion-reduce:animate-none');
  });

  it('does not divide by a zero total', () => {
    render(<DictStatusView status={{ state: 'preparing', received: 0, total: 0 }} />);
    expect(screen.getByTestId('dict-progress').getAttribute('data-determinate')).toBe('false');
    expect(screen.getByTestId('dict-progress').textContent).not.toContain('NaN');
  });

  it('clamps a received that overshoots its total rather than overflowing the track', () => {
    render(<DictStatusView status={{ state: 'preparing', received: 20, total: 10 }} />);
    expect(screen.getByTestId('dict-progress-fill').getAttribute('style')).toContain('width: 100%');
  });

  it('clamps a negative received', () => {
    render(<DictStatusView status={{ state: 'preparing', received: -5, total: 10 }} />);
    expect(screen.getByTestId('dict-progress-fill').getAttribute('style')).toContain('width: 0%');
  });

  it.each(REASONS)('gives failure reason %s its own words and a retry', (reason) => {
    const onStart = vi.fn();
    const status: DictStatus = { state: 'failed', reason, message: 'detail' };
    render(<DictStatusView status={status} onStart={onStart} />);
    const card = screen.getByTestId('dict-status');
    expect(card.getAttribute('data-reason')).toBe(reason);
    expect(screen.getByTestId('dict-retry')).toBeTruthy();
    expect(screen.getByTestId('dict-failure-detail').textContent).toBe('detail');
  });

  it.each(REASONS)('failure reason %s keeps its raw message off the screen in production', (reason) => {
    // The first-run audit found "TypeError: Failed to fetch" on a production
    // failure screen. The reason's own words and the retry are the screen.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const status: DictStatus = {
      state: 'failed',
      reason,
      message: 'the dictionary could not be fetched: TypeError: Failed to fetch',
    };
    render(<DictStatusView status={status} onStart={() => {}} showDetail={false} />);
    expect(screen.queryByTestId('dict-failure-detail')).toBeNull();
    expect(screen.getByTestId('dict-status').textContent).not.toMatch(/TypeError|fetch/);
    expect(screen.getByTestId('dict-retry')).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TypeError: Failed to fetch'));
    warn.mockRestore();
  });

  /**
   * **The diagnosis C4a's second pass kept the raw line for.** A deployer on a
   * phone must be able to tell a server without the file from an unreachable
   * one from a browser that refused storage, in a production build, without
   * the raw text the first-run audit took off the screen.
   */
  it('names the cause in plain words in production, and no two causes read alike', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases: [DictStatus & { state: 'failed' }, string][] = [
      [{ state: 'failed', reason: 'download', message: 'the dictionary manifest answered 404' }, 'not-on-server'],
      [{ state: 'failed', reason: 'download', message: 'the dictionary fetch answered 500' }, 'server-refused'],
      [{ state: 'failed', reason: 'download', message: 'the dictionary could not be fetched: TypeError: Failed to fetch' }, 'unreachable'],
      [{ state: 'failed', reason: 'download', message: 'the dictionary download was 10 bytes, the manifest says 20' }, 'incomplete'],
      [{ state: 'failed', reason: 'corrupt', message: 'the dictionary manifest is not JSON' }, 'served-page'],
      [{ state: 'failed', reason: 'storage', message: 'QuotaExceededError' }, 'storage'],
      [{ state: 'failed', reason: 'import', message: 'NotAllowedError' }, 'import'],
      [{ state: 'failed', reason: 'corrupt', message: 'sha256 mismatch' }, 'corrupt'],
    ];
    const lines = cases.map(([status, expected]) => {
      const { unmount } = render(<DictStatusView status={status} onStart={() => {}} showDetail={false} />);
      expect(screen.getByTestId('dict-status').getAttribute('data-diagnosis')).toBe(expected);
      const line = screen.getByTestId('dict-failure-diagnosis').textContent ?? '';
      expect(line).not.toMatch(/TypeError|Quota|NotAllowed|sha256|JSON|\b\d{3}\b/);
      expect(screen.getByTestId('dict-status').textContent).not.toContain(status.message);
      unmount();
      return line;
    });
    expect(new Set(lines).size).toBe(cases.length);
    warn.mockRestore();
  });

  it.each([
    ['download', 'the dictionary manifest answered 404'],
    ['corrupt', 'the dictionary manifest is not JSON'],
    ['download', 'the dictionary fetch answered 500'],
    ['corrupt', 'the dictionary engine could not start: the worker failed: x'],
  ] as const)('a %s failure caused by the server ("%s") does not say the device or the file is at fault', (reason, message) => {
    render(<DictStatusView status={{ state: 'failed', reason, message }} showDetail={false} />);
    const text = screen.getByTestId('dict-status').textContent ?? '';
    expect(text).not.toMatch(/damaged|discarded|Fetching it again is the fix|connection dropped/i);
    expect(text).toMatch(/Nothing on this device is wrong/);
  });

  it('the download body does not claim the connection dropped, since a 404 is also a download failure', () => {
    render(
      <DictStatusView
        status={{ state: 'failed', reason: 'download', message: 'the dictionary manifest answered 404' }}
        showDetail={false}
      />,
    );
    const text = screen.getByTestId('dict-status').textContent ?? '';
    expect(text).not.toMatch(/dropped|connection/i);
    expect(text).toMatch(/does not have/);
  });

  it('the four failure reasons are four different screens, not one generic one', () => {
    const seen = new Set(
      REASONS.map((reason) => {
        const { container } = render(
          <DictStatusView status={{ state: 'failed', reason, message: '' }} />,
        );
        return container.textContent ?? '';
      }),
    );
    expect(seen.size).toBe(REASONS.length);
  });

  /**
   * **The rule, inverted, in the one place a learner reads it.** `DictGate`
   * hides lookup and the reader when the store is not `ready`; practice, lists,
   * Today and stats are what keep working. The `import` body used to say the
   * opposite — "the reader and lookup keep working without it" — and every
   * other assertion in this file passed, because "four distinguishable screens"
   * is satisfied by four screens one of which is wrong.
   */
  it.each(REASONS)('failure reason %s never claims the reader or lookup keep working', (reason) => {
    render(<DictStatusView status={{ state: 'failed', reason, message: '' }} />);
    const text = screen.getByTestId('dict-status').textContent ?? '';
    expect(text).not.toMatch(/(reader|lookup)[^.]*\bkeeps? working\b/i);
    expect(text).not.toMatch(/\bkeeps? working\b[^.]*(reader|lookup)/i);
  });

  /**
   * **`import` has two producers and may assert nothing about either.** D4's is
   * a real import failure; `HttpDictStore` maps a 503 `dict-data-missing` — the
   * artifact was never built or served — onto the same reason, because the
   * frozen `DictStatus` union has no other. Copy that says the file downloaded
   * and arrived describes an event that did not happen on a deploy that skipped
   * `pnpm data`, which is the case CLAUDE.md treats as expected.
   */
  it('the import failure describes no transfer, because on one producer none happened', () => {
    render(<DictStatusView status={{ state: 'failed', reason: 'import', message: 'run pnpm data' }} />);
    const text = screen.getByTestId('dict-status').textContent ?? '';
    expect(text).not.toMatch(/download|arrived|the file/i);
    // …and the truthful diagnosis is on screen, which is what makes the silence
    // above affordable.
    expect(screen.getByTestId('dict-failure-detail').textContent).toBe('run pnpm data');
  });

  it('the storage failure is the one that tells the learner the rest still works', () => {
    render(<DictStatusView status={{ state: 'failed', reason: 'storage', message: '' }} />);
    expect(screen.getByTestId('dict-status').textContent).toMatch(/practice|lists|progress/i);
  });

  it('offers no affordance when the caller gives it no handler', () => {
    render(<DictStatusView status={{ state: 'absent' }} />);
    expect(screen.queryByTestId('dict-start')).toBeNull();
  });

  it('says different words for the native asset copy than for a download', () => {
    const { container: web } = render(<DictStatusView status={{ state: 'absent' }} />);
    const { container: native } = render(
      <DictStatusView status={{ state: 'absent' }} source="asset" />,
    );
    expect(native.textContent).not.toBe(web.textContent);
    expect(native.querySelector('[data-source]')?.getAttribute('data-source')).toBe('asset');
  });
});
