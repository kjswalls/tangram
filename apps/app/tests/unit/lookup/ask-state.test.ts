/**
 * The five answer states, and the mapping that produces them
 * (docs/plans/core.md C7).
 *
 * There is no CI, so the rule that wants enforcement is this file. The mapping
 * is four lines of `switch` and would look untestable — but the one branch that
 * matters is not mechanical at all: a `ready` answer with nothing left after
 * grounding is **`ungrounded`, not `answered`**, and that single line is the
 * visible face of PLAN.md §3.4. A refactor that collapsed it would leave the
 * panel rendering a heading over an empty body, which is precisely the failure
 * §3.4 forbids and which no screenshot would catch.
 */
import { describe, expect, it } from 'vitest';

import {
  ASK_OFFLINE_CHIP,
  ASK_UNGROUNDED_BODY,
  ASK_UNGROUNDED_TITLE,
  type AskStateName,
} from '@/components/lookup/ask-state';
import { askUiState, statusReason, unavailableReason } from '@/components/lookup/ask-panel';

describe('askUiState', () => {
  it('maps the four internal statuses onto the five the app names', () => {
    expect(askUiState({ status: 'idle' })).toBe('idle');
    expect(askUiState({ status: 'loading' })).toBe('thinking');
    expect(askUiState({ status: 'error' })).toBe('unavailable');
    expect(askUiState({ status: 'ready', grounded: true })).toBe('answered');
  });

  it('splits `ready` on whether anything survived grounding', () => {
    // The line this file exists for.
    expect(askUiState({ status: 'ready', grounded: true })).toBe('answered');
    expect(askUiState({ status: 'ready', grounded: false })).toBe('ungrounded');
  });

  it('reads a stale answer as thinking, whatever the fetch is doing', () => {
    // The panel keeps the previous question's answer on screen for the
    // debounce. To the learner that is "not ready yet", never "here is your
    // answer" — an `answered` here is how one word's answer ends up under
    // another word's heading.
    for (const status of ['idle', 'loading', 'ready', 'error'] as const) {
      expect(askUiState({ status, stale: true, grounded: true })).toBe('thinking');
    }
  });

  it('never returns a name outside the five', () => {
    const names: AskStateName[] = ['idle', 'thinking', 'answered', 'unavailable', 'ungrounded'];
    for (const status of ['idle', 'loading', 'ready', 'error'] as const) {
      for (const grounded of [true, false]) {
        expect(names).toContain(askUiState({ status, grounded }));
      }
    }
  });
});

describe('why it was unavailable', () => {
  it('names the reachability reason without the chip having to show it', () => {
    expect(unavailableReason(new DOMException('timeout', 'TimeoutError'))).toBe('timeout');
    expect(unavailableReason(new TypeError('Failed to fetch'))).toBe('offline');
    expect(unavailableReason(new Error('anything else'))).toBe('server');
  });

  it('reads an answer that did arrive from its status code', () => {
    expect(statusReason(429)).toBe('rate-limited');
    expect(statusReason(401)).toBe('no-key');
    expect(statusReason(403)).toBe('no-key');
    expect(statusReason(502)).toBe('server');
    expect(statusReason(503)).toBe('server');
  });
});

describe('the words themselves', () => {
  it('states each string exactly once, so the gallery and the panel agree', () => {
    // C1's gallery specimen and C7's panel both import these. The e2e fixtures
    // assert them too — a copy edit has to move all three or none.
    expect(ASK_OFFLINE_CHIP).toBe('Dictionary only — offline');
    expect(ASK_UNGROUNDED_TITLE).toBe('Nothing here could be checked');
    expect(ASK_UNGROUNDED_BODY).toContain('did not cite a dictionary entry');
    // No spaced-repetition jargon and no apology: C8's rule, held early.
    expect(ASK_UNGROUNDED_BODY).not.toMatch(/sorry|error|failed/i);
  });
});
