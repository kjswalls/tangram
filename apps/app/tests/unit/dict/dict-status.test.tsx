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
