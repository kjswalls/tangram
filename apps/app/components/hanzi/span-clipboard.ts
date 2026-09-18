'use client';

/**
 * The clipboard for a drag span (docs/plans/core.md C5b).
 *
 * **The app owns the clipboard here, because nothing else can.**
 * `user-select: none` on the passage means there is no native selection to
 * copy, and a `Highlight` registered in `CSS.highlights` is a *styling*
 * construct: it does not alter `document.getSelection()` and does not
 * participate in copy. So a `Cmd/Ctrl+C` with a span active would put nothing
 * on the clipboard unless this module handles it. It does.
 *
 * **The listener is on the DOCUMENT, not the passage**, and that is not a
 * convenience. A `copy` event is dispatched at the node the *selection* is in;
 * with no selection there is nothing for it to target and the event arrives at
 * the document's body. A listener on the passage element would therefore never
 * fire — which is the exact shape of bug this phase exists to avoid, because
 * every unit test of a handler attached to the passage would still pass.
 *
 * **It yields to a real selection.** A learner who selects the reader's title,
 * or text in the compose box, and presses Cmd+C gets what they selected: the
 * handler only takes over when the document's own selection is empty. Stealing
 * every copy on the page while a span happens to be active is worse than not
 * having the feature.
 *
 * On touch there is no Cmd+C, so the span gets an explicit **Copy** affordance
 * next to the lookup result — `CopySpanButton`, rendered in the word sheet.
 * C5a's harness derived the same string from its own character index; this is
 * where it becomes production code, reading the owner's span text instead.
 */
import { useEffect } from 'react';

/**
 * Write `text` to the clipboard, best effort.
 *
 * `navigator.clipboard` is absent over plain HTTP and can reject when the
 * document is not focused. Neither is worth throwing into a click handler: the
 * affordance is a convenience and the span is still on screen.
 */
export async function writeSpan(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the `copy` handler for as long as `text` is non-empty.
 *
 * `text` is the span's base characters — hanzi only, no `<rt>` text — because
 * the app is *choosing* the string rather than letting the engine derive it
 * from the DOM. That is what makes "no pinyin in the clipboard" true by
 * construction rather than by trusting `rt { user-select: none }` on three
 * engines, only one of which any audit established.
 */
export function useSpanClipboard(text: string | null | undefined): void {
  useEffect(() => {
    if (!text) return;
    const onCopy = (event: ClipboardEvent) => {
      // A real selection wins. See the header.
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
      event.clipboardData?.setData('text/plain', text);
      event.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [text]);
}
