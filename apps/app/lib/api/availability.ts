/**
 * Why an AI surface cannot reach a model, in the two kinds the learner is told
 * apart.
 *
 * There are two different situations behind "no API", and they want opposite
 * things from the screen:
 *
 *  1. **`not-configured`** — this build was made with `VITE_API_BASE` empty.
 *     Build-time and permanent: nothing the learner does will change it, so a
 *     retry button would be a dead control. Known before anything is asked
 *     (`API_CONFIGURED`), which is what lets a surface say so on first paint
 *     rather than after a spinner.
 *  2. **`unreachable`** — a base is set and nothing answered: the connection was
 *     refused or dropped, or it took too long. Transient as far as the client
 *     can tell, so a retry is exactly the right control.
 *
 * Everything else — a 502 from a provider, a 429, a 401 — is a server that
 * *did* answer, and each surface keeps the handling it already had for it.
 *
 * Nothing that is not AI imports this. Lookup, the reader, Practice, lists, the
 * importer and backup never reach `apiFetch`, and `tests/e2e/d/no-api.spec.ts`
 * asserts that by counting requests rather than by reading imports.
 */
import { API_CONFIGURED, ApiNotConfiguredError } from '@/src/access/client';

export type ApiProblem = 'not-configured' | 'unreachable';

/** The build-time half, as a problem or none. */
export function configuredProblem(configured: boolean = API_CONFIGURED): ApiProblem | undefined {
  return configured ? undefined : 'not-configured';
}

/**
 * The problem a thrown error names, or `undefined` for an error that is not
 * about reachability at all.
 *
 * - `ApiNotConfiguredError` is `apiFetch` refusing without touching the network.
 * - A `TypeError` is what `fetch` rejects with when no response arrived at all:
 *   a refused port, a dropped connection, DNS, and — because the browser hides
 *   the difference on purpose — a CORS refusal. All of them read to the learner
 *   as "the server did not answer".
 * - A `TimeoutError` is a surface's own deadline giving up on a server that
 *   accepted the connection and never replied.
 *
 * An `AbortError` is deliberately **not** here: that is the learner moving on,
 * and no surface renders it.
 */
export function apiProblemOf(error: unknown): ApiProblem | undefined {
  if (error instanceof ApiNotConfiguredError) return 'not-configured';
  if (error instanceof TypeError) return 'unreachable';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'unreachable';
  return undefined;
}
