/**
 * The clipboard for a drag span (docs/plans/core.md C5b).
 *
 * The e2e criterion drives a real Cmd+C and reads the real clipboard. What is
 * asserted here is the half that spec cannot see: that the listener is on the
 * **document** (a `user-select: none` passage has no selection for a `copy`
 * event to target, so a listener on the passage would never fire), that it
 * yields to a real selection elsewhere on the page, and that it goes away with
 * the span.
 */
import { render } from '../render';
import { describe, expect, it } from 'vitest';

import { useSpanClipboard } from '@/components/hanzi/span-clipboard';

function Harness({ text }: { text: string | null }) {
  useSpanClipboard(text);
  return <p>passage</p>;
}

/** A `copy` event with a usable `clipboardData`, which jsdom does not supply. */
function copyEvent(): { event: Event; written: () => string | undefined } {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (type: string, value: string) => data.set(type, value) },
  });
  return { event, written: () => data.get('text/plain') };
}

function select(text: string): void {
  const node = document.createElement('p');
  node.textContent = text;
  document.body.append(node);
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('useSpanClipboard', () => {
  it('writes the span, and stops the browser writing its own nothing', () => {
    render(<Harness text="打算明天" />);
    const { event, written } = copyEvent();
    document.body.dispatchEvent(event);
    expect(written()).toBe('打算明天');
    // `preventDefault` is not decoration: without it the engine's own empty
    // copy lands after ours and the clipboard ends up cleared.
    expect(event.defaultPrevented).toBe(true);
  });

  it('is on the DOCUMENT, so a copy with no selection still reaches it', () => {
    // A `copy` with nothing selected is dispatched at the body, not at the
    // passage. A listener on the passage element would be silent here — and
    // every test of it would still pass, which is why this is asserted.
    render(<Harness text="打算" />);
    const { event, written } = copyEvent();
    document.createElement('div');
    document.body.dispatchEvent(event);
    expect(written()).toBe('打算');
  });

  it('yields to a real selection elsewhere on the page', () => {
    render(<Harness text="打算" />);
    select('the reader’s title');
    const { event, written } = copyEvent();
    document.body.dispatchEvent(event);
    expect(written()).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
    document.getSelection()?.removeAllRanges();
  });

  it('writes nothing with no span active', () => {
    render(<Harness text={null} />);
    const { event, written } = copyEvent();
    document.body.dispatchEvent(event);
    expect(written()).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });

  it('is removed when the span goes, not left behind on the document', () => {
    const view = render(<Harness text="打算" />);
    view.rerender(<Harness text={null} />);
    const { event, written } = copyEvent();
    document.body.dispatchEvent(event);
    expect(written()).toBeUndefined();

    view.rerender(<Harness text="明天" />);
    const second = copyEvent();
    document.body.dispatchEvent(second.event);
    expect(second.written()).toBe('明天');

    view.unmount();
    const third = copyEvent();
    document.body.dispatchEvent(third.event);
    expect(third.written()).toBeUndefined();
  });
});
