'use client';

/**
 * Scroll restoration (docs/plans/web.md W8).
 *
 * W8 says to "confirm it is exported by the installed 8.x rather than assuming
 * the v6 spelling". It is: `react-router@8.3.1` exports `ScrollRestoration`
 * (the component) and `useScrollRestoration` (as `UNSAFE_`), and
 * `tests/unit/shell/scroll-restoration.test.ts` asserts the export rather than
 * trusting this sentence.
 *
 * This wrapper exists for one reason, and it is worth a file: **the component's
 * contract is not "restore scroll", it is "scroll to the top of every
 * navigation unless told otherwise"**. Its layout effect runs on every
 * `location` change and ends in `window.scrollTo(0, 0)` for anything that is
 * not a POP with a saved position, a hash target, or a navigation that passed
 * `preventScrollReset`. Since W8 also puts the lookup query in the URL, every
 * keystroke that settles is a navigation — so any code that writes a search
 * param has to pass `preventScrollReset: true` or the page jumps to the top
 * while somebody is typing. `src/url/lookup-query.ts` is the only such writer
 * today and it does; this note is here so the second one is not written blind.
 *
 * `getKey` is deliberately left at its default (`location.key`), which is per
 * history entry: two visits to `/library` are two places a learner was, and
 * keying on the pathname would make the second one restore the first one's
 * offset.
 */
export { ScrollRestoration as AppScrollRestoration } from 'react-router';
