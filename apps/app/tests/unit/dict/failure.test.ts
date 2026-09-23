/**
 * The failure diagnosis, read back from the messages the opener writes
 * (`lib/dict/failure.ts`; first-run audit follow-up in HANDOFF.md).
 *
 * The builders are the only producers of the shapes `diagnose` reads, so the
 * round trip is the contract: a producer that stops using a builder, or a
 * builder whose wording changes, is caught here rather than on a deploy where
 * every failure quietly reads as `unknown`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  diagnose,
  droppedMessage,
  engineMessage,
  incompleteMessage,
  offlineMessage,
  refusedMessage,
  servedPageMessage,
  unreachableMessage,
  type DictDiagnosis,
} from '@/lib/dict/failure';
import type { DictStatus } from '@/lib/dict/store';

type Failed = Extract<DictStatus, { state: 'failed' }>;
const failed = (reason: Failed['reason'], message: string): Failed => ({ state: 'failed', reason, message });

describe('diagnose', () => {
  it.each([
    [refusedMessage('manifest', 404), 'not-on-server'],
    [refusedMessage('file', 404), 'not-on-server'],
    [refusedMessage('file', 410), 'not-on-server'],
    [refusedMessage('manifest', 503), 'not-on-server'],
    [refusedMessage('file', 403), 'server-refused'],
    [refusedMessage('manifest', 500), 'server-refused'],
    [unreachableMessage(new TypeError('Failed to fetch')), 'unreachable'],
    [offlineMessage('there is no dictionary in this browser yet'), 'unreachable'],
    [offlineMessage('this browser has no storage to read one from'), 'unreachable'],
    [incompleteMessage(6_100_000, 14_000_000), 'incomplete'],
    // The connection dropping mid-body — `reader.read()` rejecting — used to
    // reach the screen as `corrupt`, "damaged" (both reviews, HANDOFF.md).
    [droppedMessage(6_100_000, new TypeError('network error')), 'incomplete'],
    [engineMessage('CompileError: wasm validation error'), 'engine'],
    ['Connection reset after 6.1 MB', 'unknown'],
  ] as const)('a download failure "%s" is %s', (message, expected) => {
    expect(diagnose(failed('download', message))).toBe(expected satisfies DictDiagnosis);
  });

  it('reads a web page served in place of the manifest or the file as served-page', () => {
    // Both arrive as `corrupt` — the bytes are not what was asked for — and an
    // SPA fallback answering a missing path with index.html is the usual cause.
    expect(diagnose(failed('corrupt', servedPageMessage('manifest')))).toBe('served-page');
    expect(diagnose(failed('corrupt', servedPageMessage('file')))).toBe('served-page');
    // …and JSON of the wrong shape, an API fallback answering `{}`.
    expect(diagnose(failed('corrupt', servedPageMessage('manifest-shape')))).toBe('served-page');
  });

  it('reads an engine that would not start as engine under any reason', () => {
    // A worker that dies reaches the store as a plain Error, which it files as
    // `corrupt`; a missing `sqlite3.wasm` is filed as `download`.
    expect(diagnose(failed('corrupt', engineMessage('the worker failed: x')))).toBe('engine');
    expect(diagnose(failed('download', engineMessage('x')))).toBe('engine');
  });

  it('passes the other three reasons through as themselves', () => {
    expect(diagnose(failed('storage', 'QuotaExceededError'))).toBe('storage');
    expect(diagnose(failed('import', 'OPFS: NotAllowedError'))).toBe('import');
    expect(diagnose(failed('corrupt', 'sha256 mismatch'))).toBe('corrupt');
    // An HTTP-shaped message under another reason is not reinterpreted.
    expect(diagnose(failed('storage', refusedMessage('file', 404)))).toBe('storage');
  });

  /**
   * The producers, checked in their own source: every failure message the
   * worker and the runner write about a request is built here, not inlined.
   * Inlining one is how a wording tweak turns "not on the server" into
   * "unknown" with every other test still green.
   */
  it.each(['lib/dict/runners/wasm-worker.ts', 'lib/dict/runners/wasm.ts'])(
    '%s writes its request failures with the builders',
    (file) => {
      const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
      const source = readFileSync(resolve(appRoot, file), 'utf8');
      expect(source).not.toMatch(/`the dictionary (?:manifest|fetch) answered/);
      // (`onUnavailable`'s "could not be fetched; trying stored bytes" is a notice, not a failure.)
      expect(source).not.toMatch(/['`]the dictionary (?:manifest )?could not be fetched(?::| and)/);
      expect(source).not.toMatch(/['`]the dictionary download (?:was|is not)/);
      expect(source).not.toMatch(/['`]the dictionary manifest (?:is not JSON|has no file)/);
      expect(source).not.toMatch(/['`]the dictionary (?:worker failed|engine)/);
      // Every body read goes through the one wrapper that says "dropped", not
      // "damaged": the only `reader.read()` allowed is the one inside it.
      const reads = source.match(/reader\.read\(\)/g) ?? [];
      expect(reads.length).toBeLessThanOrEqual(1);
      if (reads.length === 1) expect(source).toMatch(/function readChunk[\s\S]{0,200}reader\.read\(\)/);
    },
  );
});
