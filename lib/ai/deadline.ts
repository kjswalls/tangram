/**
 * One deadline for every provider call.
 *
 * The provider interface takes no `AbortSignal` (the SDK's own timeout is 45 s,
 * across two sequential calls), so a route that must answer sooner races the
 * call instead: the request may still be in flight, but nobody is waiting on it
 * any more. Each caller sets its own `ms`, and they differ on purpose — a card
 * back is a worse place to hang than a lookup panel, because the learner is
 * mid-review with a grade to press.
 *
 * This lives here rather than in any one route because all three routes need
 * it. It was a private copy in `/api/ask` and again in `/api/recall`, and a
 * public one in `lib/ai/examples.ts`, each written by a different builder who
 * could not edit the others' files; the Phase 7 merge is where they fold
 * together. Nothing about the behaviour changed in the folding — the three
 * bodies were identical.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
