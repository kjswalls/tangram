/**
 * The sheet's accessibility contract (docs/plans/core.md C1).
 *
 * Every assertion here is one of C1's acceptance criteria: the trap holds while
 * it is open, Escape closes it, a press on the backdrop closes it, focus goes
 * back to whatever opened it, and it is announced as a modal dialog. A sheet
 * that fails any of these is one a keyboard user cannot get out of, and the
 * reader tap is the app's most-used gesture.
 */
import { useState } from 'react';

import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Sheet } from '@/components/ui/sheet';

import { render, screen } from '../render';

function Harness({ onClose }: { onClose?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      <button type="button">outside</button>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        title="A word"
      >
        <button type="button">first</button>
        <button type="button">second</button>
      </Sheet>
    </>
  );
}

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal dialog with an accessible name', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog).toHaveAccessibleName('A word');
  });

  it('moves focus into the sheet on open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  /**
   * **These two assert the SEQUENCE, not containment**, and the difference is
   * the finding that made them. The trap's candidate filter used to be
   * `offsetParent !== null`; jsdom implements no layout, so that is null for
   * every element, the candidate list collapsed to whichever node already had
   * focus, and every Tab re-focused it. "Focus is still inside the dialog" was
   * then trivially true whatever the wrap logic did — including with the wrap
   * inverted, or absent. A sequence assertion cannot pass on a dead trap.
   */
  it('Tab visits every focusable child in order and wraps, never leaving the sheet', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    const dialog = screen.getByRole('dialog');
    const outside = screen.getByRole('button', { name: 'outside' });
    const names = () => (document.activeElement as HTMLElement | null)?.textContent ?? '(none)';

    const seen: string[] = [names()];
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(document.activeElement).not.toBe(outside);
      expect(dialog.contains(document.activeElement)).toBe(true);
      seen.push(names());
    }
    // Close, first, second — in DOM order — and then round again.
    expect(seen).toEqual(['Close', 'first', 'second', 'Close', 'first', 'second', 'Close']);
  });

  it('Shift+Tab walks the same ring backwards', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    const dialog = screen.getByRole('dialog');
    const names = () => (document.activeElement as HTMLElement | null)?.textContent ?? '(none)';

    const seen: string[] = [names()];
    for (let i = 0; i < 6; i += 1) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
      seen.push(names());
    }
    expect(seen).toEqual(['Close', 'second', 'first', 'Close', 'second', 'first', 'Close']);
  });

  it('holds focus when the sheet has nothing focusable but its own close button', async () => {
    const user = userEvent.setup();
    function Bare() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            opener
          </button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Bare">
            <p>nothing to focus</p>
          </Sheet>
        </>
      );
    }
    render(<Bare />);
    await user.click(screen.getByRole('button', { name: 'opener' }));
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 3; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a drag that starts inside and ends on the backdrop does not close it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    // `mousedown` on the backdrop is what closes; a text selection that ends
    // there must not. This is why the handler is `onMouseDown` and not `onClick`.
    await user.pointer([
      { keys: '[MouseLeft>]', target: screen.getByRole('button', { name: 'first' }) },
      { target: screen.getByTestId('sheet-backdrop') },
      { keys: '[/MouseLeft]' },
    ]);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('closes on a press on the backdrop, and not on a press inside', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    await user.click(screen.getByRole('button', { name: 'first' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();

    await user.click(screen.getByTestId('sheet-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores focus to the opener when it closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'opener' });
    await user.click(opener);
    await user.keyboard('{Escape}');

    expect(document.activeElement).toBe(opener);
  });

  it('has a close button that is reachable and closes it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'opener' }));

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
