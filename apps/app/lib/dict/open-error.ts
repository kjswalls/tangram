/**
 * A failure to open the dictionary, carrying the word the banner needs
 * (docs/plans/data.md D4).
 *
 * `DictStatus.failed` distinguishes four reasons because they need different
 * words on screen: a truncated download is "try again", a file that is not this
 * artifact is "we will re-fetch it", and no storage at all is neither. Until D4
 * every runner could only say "the file did not open as this dictionary", so
 * `SqliteDictStore` reported `corrupt` for everything (HANDOFF.md, D2). This is
 * how a runner says which of the four it actually was.
 *
 * Its own module, and a very small one, so that `lib/dict/runners/wasm.ts` does
 * not have to import `sqlite-store.ts` to throw, and `sqlite-store.ts` does not
 * have to import a runner to catch. Neither of the two frozen modules
 * (`store.ts`, `sql.ts`) gains runtime code for it.
 */
import type { DictStatus } from './store';

export type DictFailureReason = Extract<DictStatus, { state: 'failed' }>['reason'];

export class DictOpenError extends Error {
  override readonly name = 'DictOpenError';
  readonly reason: DictFailureReason;

  constructor(reason: DictFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
  }
}
