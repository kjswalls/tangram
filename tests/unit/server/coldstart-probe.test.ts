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
  SEQUENCE,
  verdict,
  warmUpLine,
  type ProbeResult,
  type Sample,
  type Step,
} from '@/scripts/coldstart-probe';
import { DICT_INDEX_PARTS } from '@/lib/dict/index';

const STEP: Step = { name: 'first search', method: 'GET', path: '/api/dict/search?q=dasuan' };

function sample(overrides: Partial<Sample> = {}): Sample {
  return { step: STEP, ms: 12, status: 200, instance: 'i-1', parts: ['sorted'], ...overrides };
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
    const { line, exitCode } = verdict(result([sample(), sample(), sample()]));
    expect(exitCode).toBe(0);
    expect(line).toContain('one process');
  });

  it('fails when two ids answered, because the latencies are then incomparable', () => {
    const { line, exitCode } = verdict(result([sample(), sample({ instance: 'i-2' })]));
    expect(exitCode).toBe(1);
    expect(line).toContain('2 instance ids');
    expect(line).toContain('maxDuration');
  });

  it('treats a non-2xx as an invalid sample, not as a slow one', () => {
    // A 401 or a 503 never did the work being timed. Reporting its latency as a
    // datum is how a gated deployment gets certified as fast.
    const { line, exitCode } = verdict(
      result([sample(), sample({ status: 401, instance: null, parts: null })]),
    );
    expect(exitCode).toBe(1);
    expect(line).toContain('invalid run');
    expect(line).toContain('401');
  });

  it('counts a transport failure as invalid too', () => {
    const { exitCode } = verdict(result([sample({ status: 0, error: 'fetch failed' })]));
    expect(exitCode).toBe(1);
  });

  it('says so plainly when the deployment predates the headers', () => {
    // This is the run against the *previous* deploy, which is half of the
    // phase's result. It has latencies and no way to prove they share a process.
    const { line, exitCode } = verdict(result([sample({ instance: null, parts: null })]));
    expect(exitCode).toBe(0);
    expect(line).toContain('predates');
  });

  it('refuses to average a mix of stamped and unstamped responses', () => {
    const { line, exitCode } = verdict(result([sample(), sample({ instance: null, parts: null })]));
    expect(exitCode).toBe(1);
    expect(line).toContain('no header at all');
  });
});

describe('the warm-up line', () => {
  const afterWait = (parts: string[] | null): Sample =>
    sample({ step: { ...STEP, waitBeforeMs: 2_000 }, parts });

  it('reads the first post-wait response, and calls a full parts list settled', () => {
    expect(warmUpLine(result([sample(), afterWait([...DICT_INDEX_PARTS])]))).toContain('settled');
  });

  it('names what is missing when the warm-up did not finish in the wait', () => {
    const line = warmUpLine(result([sample(), afterWait(['sorted', 'entries', 'hsk'])]));
    expect(line).toContain('NOT settled');
    expect(line).toContain('3/6');
    expect(line).toContain('hanzi');
  });

  it('says unknown rather than guessing when there is no parts header', () => {
    expect(warmUpLine(result([afterWait(null)]))).toContain('unknown');
  });
});
