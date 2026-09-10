/**
 * The probe's reading of a run, without a server.
 *
 * `runProbe` needs a deployment; `verdict` and `warmUpLine` are what turn seven
 * responses into a claim, and they are the part that can be wrong in a way
 * nobody notices — a probe that says "one process" whatever it saw is worse than
 * no probe, because it will be quoted.
 */
import { describe, expect, it } from 'vitest';

import {
  preWarmReason,
  SEQUENCE,
  verdict,
  warmUpLine,
  type ProbeResult,
  type Sample,
  type Step,
} from '@/scripts/coldstart-probe';
import { DICT_INDEX_PARTS } from '@/lib/dict/index';

const STEP: Step = { name: 'first search', method: 'GET', path: '/api/dict/search?q=dasuan' };

/**
 * The banner's HEAD as a *cold* process answers it: three parts, not yet warm, and
 * slow enough to have parsed 33 MB of JSON. Every `result()` below starts with one,
 * because a run whose first sample says otherwise is a run against a warm instance
 * and the probe now refuses it — which would otherwise swallow every other case.
 */
function coldHead(overrides: Partial<Sample> = {}): Sample {
  return sample({
    step: { name: 'banner HEAD hsk', method: 'HEAD', path: '/api/dict/hsk?band=1' },
    ms: 690,
    parts: ['sorted', 'entries', 'hsk'],
    warm: false,
    ...overrides,
  });
}

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    step: STEP,
    ms: 12,
    status: 200,
    instance: 'i-1',
    parts: ['sorted'],
    warm: false,
    ...overrides,
  };
}

function result(samples: Sample[]): ProbeResult {
  const instances: string[] = [];
  for (const s of samples) {
    if (s.instance && !instances.includes(s.instance)) instances.push(s.instance);
  }
  return {
    samples,
    instances,
    invalid: samples.filter((s) => s.error !== undefined || s.status < 200 || s.status >= 300),
    missingHeaders: samples.some((s) => s.error === undefined && s.instance === null),
    preWarm: preWarmReason(samples),
  };
}

describe('the sequence', () => {
  it('opens with the banner’s HEAD, which is what starts the warm-up', () => {
    expect(SEQUENCE[0]).toMatchObject({ method: 'HEAD', path: '/api/dict/hsk?band=1' });
  });

  it('waits once, and only before the first request after the probe', () => {
    const waits = SEQUENCE.filter((step) => step.waitBeforeMs !== undefined);
    expect(waits).toHaveLength(1);
    expect(SEQUENCE.indexOf(waits[0])).toBe(1);
  });

  it('repeats every dictionary sample, so a first can be compared with a second', () => {
    const firsts = SEQUENCE.filter((step) => step.name.startsWith('first'));
    const repeats = SEQUENCE.filter((step) => step.name.startsWith('repeat'));
    expect(firsts.map((s) => s.path)).toEqual(repeats.map((s) => s.path));
    expect(firsts.length).toBe(3);
  });

  it('never samples /api/ask — it reads no dictionary', () => {
    // It is the gate check and nothing else; timing it would put a number that
    // means nothing about the warm-up next to numbers that do.
    expect(SEQUENCE.some((step) => step.path.startsWith('/api/ask'))).toBe(false);
  });
});

describe('the verdict', () => {
  it('is one process when every response carries the same id', () => {
    const { line, exitCode } = verdict(result([coldHead(), sample(), sample()]));
    expect(exitCode).toBe(0);
    expect(line).toContain('one process');
  });

  it('names what it did not see, so a green line cannot be read as certifying all eight routes', () => {
    // Four of the eight routes carry no header or are never sampled, and a second
    // instance serving somebody else's traffic is invisible to a sequential run.
    const { line } = verdict(result([coldHead(), sample()]));
    expect(line).toContain('Not observed');
    expect(line).toContain('/api/ask');
    expect(line).toContain('concurrent traffic');
  });

  it('fails when two ids answered, because the latencies are then incomparable', () => {
    const { line, exitCode } = verdict(result([coldHead(), sample({ instance: 'i-2' })]));
    expect(exitCode).toBe(1);
    expect(line).toContain('2 instance ids');
    expect(line).toContain('maxDuration');
  });

  it('treats a non-2xx as an invalid sample, not as a slow one', () => {
    // A 401 or a 503 never did the work being timed. Reporting its latency as a
    // datum is how a gated deployment gets certified as fast.
    const { line, exitCode } = verdict(
      result([coldHead(), sample({ status: 401, instance: null, parts: null, warm: null })]),
    );
    expect(exitCode).toBe(1);
    expect(line).toContain('invalid run');
    expect(line).toContain('401');
  });

  it('counts a transport failure as invalid too', () => {
    const { exitCode } = verdict(result([coldHead(), sample({ status: 0, error: 'fetch failed' })]));
    expect(exitCode).toBe(1);
  });

  it('fails an unstamped run by default — a deployment can lose the headers for reasons other than age', () => {
    // A proxy stripping `x-tangram-*`, or the wrapper dropped from a route, look
    // exactly like an old build; defaulting to "fine" keeps the gate green while
    // the phase's only outside evidence is gone.
    const { line, exitCode } = verdict(
      result([coldHead({ instance: null, parts: null, warm: null }), sample({ instance: null, parts: null, warm: null })]),
    );
    expect(exitCode).toBe(1);
    expect(line).toContain('predates');
    expect(line).toContain('--allow-unstamped');
  });

  it('accepts an unstamped run with --allow-unstamped, which is the previous-deploy comparison', () => {
    // This is the run against the *previous* deploy, which is half of the phase's
    // result. It has latencies and no way to prove they share a process — and
    // asking for it is a deliberate act, so it takes a flag.
    const { line, exitCode } = verdict(
      result([coldHead({ instance: null, parts: null, warm: null })]),
      { allowUnstamped: true },
    );
    expect(exitCode).toBe(0);
    expect(line).toContain('predates');
  });

  it('refuses to average a mix of stamped and unstamped responses', () => {
    const { line, exitCode } = verdict(
      result([coldHead(), sample({ instance: null, parts: null, warm: null })]),
    );
    expect(exitCode).toBe(1);
    expect(line).toContain('no header at all');
  });
});

describe('an instance that was already warm', () => {
  const fullParts = [...DICT_INDEX_PARTS];

  it('is caught by a HEAD that already lists every index part', () => {
    // A cold HEAD builds three parts and schedules the rest in `after()`, so a
    // HEAD stamped with all six was answered by a process somebody warmed first.
    expect(preWarmReason([coldHead({ parts: fullParts, warm: true, ms: 9 })])).toContain(
      'all 6 index parts',
    );
  });

  it('is caught by a HEAD too fast to have parsed the dictionary', () => {
    // The partial case the parts list cannot see: one earlier `GET entries` pays
    // the ~650 ms parse and still leaves three parts, so only the clock shows it.
    const reason = preWarmReason([coldHead({ ms: 12 })]);
    expect(reason).toContain('12 ms');
  });

  it('leaves a genuinely cold run alone', () => {
    expect(preWarmReason([coldHead()])).toBeNull();
  });

  it('says nothing about a HEAD that failed — invalid owns that run', () => {
    expect(preWarmReason([coldHead({ status: 401, ms: 4 })])).toBeNull();
    expect(preWarmReason([coldHead({ status: 0, ms: 4, error: 'fetch failed' })])).toBeNull();
  });

  it('exits non-zero, so the run cannot be quoted as a cold-start result', () => {
    const { line, exitCode } = verdict(
      result([coldHead({ parts: fullParts, warm: true, ms: 9 }), sample({ warm: true })]),
    );
    expect(exitCode).toBe(1);
    expect(line).toContain('already warm');
    expect(line).toContain('measures nothing');
  });
});

describe('the warm-up line', () => {
  const afterWait = (parts: string[] | null, warm: boolean | null = true): Sample =>
    sample({ step: { ...STEP, waitBeforeMs: 2_000 }, parts, warm });

  it('calls a run settled only when the warm flag says so', () => {
    expect(warmUpLine(result([coldHead(), afterWait([...DICT_INDEX_PARTS])]))).toContain('settled');
  });

  it('does NOT call a full parts list settled while the flag says no', () => {
    // The finding this line exists for: `builtIndexParts()` cannot see the
    // headword and DAG caches, so all six parts and a 145 ms first paste are the
    // same reading. The flag is the one that answers the question.
    const line = warmUpLine(result([coldHead(), afterWait([...DICT_INDEX_PARTS], false)]));
    expect(line).toContain('NOT settled');
    expect(line).toContain('segment-stats');
    expect(line).not.toMatch(/(?<!NOT )settled —/);
  });

  it('names what is missing when the warm-up did not finish in the wait', () => {
    const line = warmUpLine(result([coldHead(), afterWait(['sorted', 'entries', 'hsk'], false)]));
    expect(line).toContain('NOT settled');
    expect(line).toContain('3/6');
    expect(line).toContain('hanzi');
  });

  it('says unknown rather than guessing when the warm header is absent', () => {
    // An older build: the parts are all it can say, and it must not round that up.
    const line = warmUpLine(result([coldHead(), afterWait([...DICT_INDEX_PARTS], null)]));
    expect(line).toContain('unknown');
    expect(line).toContain('headwords');
  });

  it('says unknown rather than guessing when there is no parts header', () => {
    expect(warmUpLine(result([afterWait(null, null)]))).toContain('unknown');
  });
});
