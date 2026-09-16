/**
 * The web dictionary: `sqlite-wasm` on OPFS, in a worker (docs/plans/data.md D4).
 *
 * Eight criteria, and three of them are **measurements rather than assertions** —
 * the query latency table, what a second tab actually transfers, and
 * `PRAGMA integrity_check` on the real 43 MB file in wasm. Those numbers settle
 * STACK known-unknown #10 ("2–5× native" was an extrapolation nobody ran) and
 * two paragraphs in `data.md` D4 that are otherwise guesses. They are written to
 * `test-results/d4-record.json` and copied into `HANDOFF.md`, the same way
 * `core.md` C5a's harness records its numbers.
 *
 * Everything here drives `/dict-wasm`, a standalone dev/e2e-only page whose
 * `window.__dictWasm` is a thin skin over the real `SqliteDictStore` on the real
 * OPFS runner. Nothing is faked: the artifact is the one `pnpm data` built, the
 * worker is the one the build emits, and the comparisons in criterion 1 are
 * against the same store on `node:sqlite` running in this process.
 *
 * **Serial, and each test gets its own browser context.** OPFS and the HTTP
 * cache are per-context state, and half of these criteria are about exactly that
 * state — a reload that fetches nothing, a second tab that cannot take the
 * pool's exclusive lock, an eviction. Sharing a context between tests would make
 * each one depend on the last.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { expect, test, type Page } from '@playwright/test';

import { MANIFEST_FILE, type DictManifest } from '../../../lib/dict/artifact';
import { nodeRunner } from '../../../lib/dict/runners/node';
import { SqliteDictStore } from '../../../lib/dict/sqlite-store';
import { workspaceRoot } from '../../../lib/server/roots';

const RECORD = 'test-results/d4-record.json';
const record: Record<string, unknown> = {};

/**
 * Merge rather than overwrite, and this is not fussiness.
 *
 * **Playwright restarts its worker process after a failed test**, so module
 * state — including this object — is reset. A `write()` that serialises only
 * what the current process has collected silently drops every section recorded
 * before the first failure, and the phase writeup then reports a table that
 * exists only in a terminal scrollback. The first version of this file did
 * exactly that: the run that found the 50 ms breach shipped a record file
 * containing one of its six sections.
 */
function write(): void {
  mkdirSync(dirname(RECORD), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(RECORD)) {
    try {
      existing = JSON.parse(readFileSync(RECORD, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  writeFileSync(RECORD, JSON.stringify({ ...existing, ...record }, null, 2));
}

const DATA_DIR = process.env.TANGRAM_DATA_DIR
  ? resolve(workspaceRoot(), process.env.TANGRAM_DATA_DIR)
  : resolve(workspaceRoot(), 'data');

const manifest = JSON.parse(readFileSync(join(DATA_DIR, MANIFEST_FILE), 'utf8')) as DictManifest;
const ARTIFACT = join(DATA_DIR, manifest.file);
const ARTIFACT_URL = `/${manifest.file}`;

/**
 * The fixed query list criterion 1 compares runner for runner.
 *
 * It is deliberately the traps: the astral-plane headword the prefix range
 * sentinel drops, the ü/v folding, the neutral tone, the polyphone whose
 * readings sit under two different pinyin keys, a gloss query, a two-term gloss
 * query, and the `char_words` BLOB path — which is the only column in the whole
 * artifact that is not TEXT or INTEGER, and therefore the only place a runner
 * can disagree about a *type* rather than a value.
 */
const CALLS = [
  { method: 'search', args: ['打算'] },
  { method: 'search', args: ['打'] },
  { method: 'search', args: ['中华人民共和国'] },
  { method: 'search', args: ['了'] },
  { method: 'search', args: ['dasuan'] },
  { method: 'search', args: ['da3suan4'] },
  { method: 'search', args: ['dǎsuàn'] },
  { method: 'search', args: ['DaSuan'] },
  { method: 'search', args: ['dasu'] },
  { method: 'search', args: ['wo3men'] },
  { method: 'search', args: ['wǒmen'] },
  { method: 'search', args: ['xian'] },
  { method: 'search', args: ["xi1'an1"] },
  { method: 'search', args: ['lu:4'] },
  { method: 'search', args: ['lv4'] },
  { method: 'search', args: ['lǜ'] },
  { method: 'search', args: ['nu:3'] },
  { method: 'search', args: ['hé'] },
  { method: 'search', args: ['shi'] },
  { method: 'search', args: ['𩽾'] },
  { method: 'search', args: ['𧿹'] },
  { method: 'search', args: ['plan'] },
  { method: 'search', args: ['to plan'] },
  { method: 'search', args: ['women'] },
  { method: 'search', args: ['sun'] },
  // The two queries the gloss cap truncates. They are the ones the `ORDER BY`
  // removal put at risk — below the cap the sorted and unsorted forms cannot
  // differ at all — so leaving them out would be leaving out the case.
  { method: 'search', args: ['to'] },
  { method: 'search', args: ['the'] },
  { method: 'hskBand', args: [1, { limit: 40 }] },
  { method: 'hskBand', args: [7, { limit: 40, offset: 100 }] },
  { method: 'readingCount', args: ['看'] },
  { method: 'readingCount', args: ['了'] },
  { method: 'wordsContaining', args: ['算', { limit: 30 }] },
  { method: 'wordsContaining', args: ['𩽾', {}] },
  { method: 'segment', args: ['我打算明天去北京'] },
  { method: 'segment', args: ['學習', { script: 'simp' }] },
  { method: 'segment', args: ['学习', { script: 'trad' }] },
  { method: 'segment', args: ['研究生命的起源'] },
] as const;

async function openHarness(page: Page): Promise<void> {
  await page.goto('/dict-wasm');
  await expect(page.getByTestId('dict-wasm-harness')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__dictWasm));
}

interface WorkerTransfer {
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  durationMs: number;
}

type OpenResult =
  | {
      ok: true;
      report: {
        mode: string;
        downloaded: number;
        imported: boolean;
        transfer: WorkerTransfer | null;
        sqliteVersion: string;
      };
    }
  | { ok: false; status: { state: string; reason?: string; message?: string } };

function open(page: Page, options: Record<string, unknown> = {}): Promise<OpenResult> {
  return page.evaluate(
    (opts) => window.__dictWasm!.open(opts) as unknown as Promise<OpenResult>,
    options,
  );
}

test.describe('the OPFS dictionary', () => {
  // A 43 MB import in wasm is not a fast thing, and three tests do it twice.
  test.setTimeout(240_000);

  test.afterAll(() => write());

  /**
   * Criterion 1 — the same answers as the Node runner.
   *
   * Same assertions, different runner: that is the whole point of the
   * `SqlRunner` seam. The oracle is `SqliteDictStore` over `node:sqlite` in this
   * process against the same file, so the comparison is exact rather than a
   * golden blob somebody blessed.
   */
  test('answers every query exactly as the Node runner does', async ({ page }) => {
    await openHarness(page);
    const opened = await open(page);
    expect(opened.ok, JSON.stringify(opened)).toBe(true);

    const store = new SqliteDictStore({ connect: async () => nodeRunner(ARTIFACT) });
    await store.open();
    try {
      for (const call of CALLS) {
        const label = `${call.method}(${JSON.stringify(call.args)})`;
        const expected = await (
          store[call.method] as (...args: unknown[]) => Promise<unknown>
        )(...(call.args as readonly unknown[]));
        const actual = await page.evaluate(
          ([method, args]) =>
            (window.__dictWasm as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
              method as string
            ](...(args as unknown[])),
          [call.method, [...call.args]] as [string, unknown[]],
        );
        // Through `JSON.parse(JSON.stringify(...))` on the Node side too: the
        // browser's answer has been round-tripped by `page.evaluate`, so
        // comparing a live object against a serialised one would report
        // differences the runners do not have (an `undefined` field that
        // survives on one side and not the other).
        expect(actual, label).toEqual(JSON.parse(JSON.stringify(expected)));
      }
      /**
       * `entries()` separately, over more ids than one statement can bind.
       *
       * D3 chunks every unbounded `IN (…)` at 900 values and re-sorts the
       * chunks centrally, because `ORDER BY rowid` orders rows *within* a
       * statement. That path is the one place a runner can disagree about
       * ordering rather than about values, and it is invisible to any call
       * small enough to fit in one statement — so this feeds it 1,200 ids.
       */
      const many = ((await store.hskBand(7, { limit: 1200 })) as { id: string }[]).map(
        (entry) => entry.id,
      );
      expect(many.length).toBeGreaterThan(900);
      const expectedMany = await store.entries(many);
      const actualMany = await page.evaluate(
        (ids) => window.__dictWasm!.entries(ids),
        many,
      );
      expect(actualMany).toEqual(JSON.parse(JSON.stringify(expectedMany)));

      record.parity = { calls: CALLS.length, chunkedEntryIds: many.length };
    } finally {
      await store.close();
    }
  });

  /**
   * Criterion 2 — the latency table, measured, not extrapolated.
   *
   * The store is opened with its result cache off (`cacheSize: 0`), or every run
   * after the first would be a `Map` lookup and the table would measure the
   * cache. D4 says: if any interactive query exceeds 50 ms, stop and report.
   *
   * **It fired, it was reported, and the decision came back "no".** Two queries
   * breach the bar — `to` and `the`, the English tokens whose FTS5 posting lists
   * are larger than `MAX_GLOSS_CANDIDATES` — and they are listed below by name
   * with the numbers measured when the phase closed. Everything else must stay
   * under 50 ms and the two named queries must not get *worse*, so the exemption
   * is a pinned measurement rather than a hole.
   *
   * The lever the breach points at is the gloss cap, and the orchestrator ruled
   * it stays at 5,000: at that cap the truncation binds eight tokens, every one
   * an English function word, while at 1,000 it binds fifty-two including the
   * content words a learner actually types. The distribution is in
   * `lib/dict/query/gloss.ts` and pinned by
   * `tests/unit/dict/gloss-order.test.ts`; `HANDOFF.md` carries the reasoning.
   * **This pin is therefore permanent**, not provisional — it closes only if the
   * two-pass projection follow-up in HANDOFF is built and turns out to pay.
   */
  const KNOWN_BREACH: Record<string, number> = {
    // Measured at 89–100 ms across runs when this phase closed, with the
    // redundant `ORDER BY e.rowid` removed — the statement behind it was
    // 1,117–1,137 ms with the clause in place. What is left is 5,000 nine-column
    // rows crossing the worker boundary plus `glossTier` over all of them.
    // The ceiling is ~2× the measurement:
    // enough headroom for a shared container's noise, tight enough that a real
    // regression fails rather than fitting underneath it.
    "search('to') — 31,561 postings, over the 5,000 cap": 200,
    "search('the') — over the 5,000 cap": 200,
  };

  test('reports WASM query latency; two over-cap gloss queries breach the 50 ms bar', async ({
    page,
  }) => {
    await openHarness(page);
    const openedAt = Date.now();
    const opened = await open(page, { cacheSize: 0 });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const coldOpenMs = Date.now() - openedAt;

    const names = await page.evaluate(() => window.__dictWasm!.timed());
    const table: Record<string, number> = {};
    for (const name of names) {
      table[name] = await page.evaluate((call) => window.__dictWasm!.time(call, 10), name);
    }
    /**
     * `open()`'s own two statements, isolated — the number `data.md` D2 asked
     * D4 for by name ("`open()` at 39.6 ms is the biggest single cost in the
     * layer and it is almost entirely the 14,625-row `chars` read… Measure it
     * in D4 before changing anything"). `coldOpenMs` and the reload test's warm
     * open both fold in the worker's start-up and the wasm module's
     * instantiation; this is the read alone.
     */
    const openBatch = await page.evaluate(() =>
      window.__dictWasm!.timeSql(
        [
          { sql: 'SELECT key, value FROM meta' },
          { sql: 'SELECT ch, simp_evidence, trad_evidence FROM chars' },
        ],
        10,
      ),
    );

    record.latency = {
      note: 'mean ms over 10 runs after one warm-up, result cache disabled, container Chromium',
      coldOpenMsIncludingImport: coldOpenMs,
      openBatchMs: openBatch.ms,
      openBatchRows: openBatch.rows,
      breachesFiftyMs: Object.entries(table)
        .filter(([, ms]) => ms > 50)
        .map(([name, ms]) => `${name}: ${ms.toFixed(1)} ms`),
      queries: table,
    };
    write();

    // `hskBand(1)` returns the whole 5,638-entry band and is a list screen, not
    // a keystroke; everything else on the list is on the interactive path.
    const interactive = Object.entries(table).filter(([name]) => !name.startsWith('hskBand(1)'));
    const unexpected = interactive.filter(
      ([name, ms]) => ms > 50 && KNOWN_BREACH[name] === undefined,
    );
    expect(
      unexpected.map(([name, ms]) => `${name}: ${ms.toFixed(1)} ms`).join('\n'),
      'D4 criterion 2: an interactive query exceeded 50 ms in WASM — stop and report',
    ).toBe('');

    // The two known breaches are pinned, not waved through: they must still be
    // there (a breach that silently healed means the table is measuring the
    // wrong thing) and they must not get worse.
    for (const [name, ceiling] of Object.entries(KNOWN_BREACH)) {
      expect(table[name], `${name} is no longer in the table`).toBeGreaterThan(0);
      expect(table[name], `${name} regressed past its pinned ceiling`).toBeLessThan(ceiling);
    }
  });

  /**
   * Where the breach comes from, recorded so the decision it needs can be taken
   * without re-deriving it.
   *
   * Three facts, all measured here against the real artifact:
   *
   *  1. `"to"` matches 31,561 rows, six times the 5,000 cap.
   *  2. With `ORDER BY e.rowid`, SQLite materialises and sorts **all** of them
   *     before the `LIMIT` — so the cost is the same at `LIMIT 400` as at
   *     `LIMIT 5000`, and `data.md` §6's "a smaller `LIMIT`" lever does nothing
   *     at all for this shape. That sort is what D4 removed.
   *  3. What is left is marshalling: 5,000 rows of nine columns cost about the
   *     same whether they come from the FTS join or from a plain rowid range, so
   *     the remaining lever really is the cap.
   */
  test('records where the gloss path spends its time', async ({ page }) => {
    await openHarness(page);
    expect((await open(page, { cacheSize: 0 })).ok).toBe(true);
    const cols = `e.${'rowid, id, simp, trad, is_variant, proper_noun, hsk_band, freq_rank'
      .split(', ')
      .join(', e.')}, e.glosses`;
    const join = `FROM gloss_fts f JOIN entries e ON e.rowid = f.rowid WHERE f.gloss_fts MATCH ?`;
    const probes: Record<string, { sql: string; params: (string | number)[] }> = {
      'fts rowid only, LIMIT 5000': {
        sql: 'SELECT rowid FROM gloss_fts WHERE gloss_fts MATCH ? LIMIT ?',
        params: ['"to"', 5000],
      },
      'joined, rowid only, LIMIT 5000': {
        sql: `SELECT e.rowid ${join} LIMIT ?`,
        params: ['"to"', 5000],
      },
      'joined, full projection, LIMIT 5000 (what search sends)': {
        sql: `SELECT ${cols} ${join} LIMIT ?`,
        params: ['"to"', 5000],
      },
      'joined, full projection, LIMIT 1000': {
        sql: `SELECT ${cols} ${join} LIMIT ?`,
        params: ['"to"', 1000],
      },
      'joined, full projection, ORDER BY rowid, LIMIT 5000 (D3 form)': {
        sql: `SELECT ${cols} ${join} ORDER BY e.rowid LIMIT ?`,
        params: ['"to"', 5000],
      },
      'joined, full projection, ORDER BY rowid, LIMIT 400 (D3 form, tighter cap)': {
        sql: `SELECT ${cols} ${join} ORDER BY e.rowid LIMIT ?`,
        params: ['"to"', 400],
      },
      'plain rowid range over entries, 5000 rows': {
        sql: `SELECT ${cols.replace(/ FROM.*/, '')} FROM entries e WHERE e.rowid <= 5000`,
        params: [],
      },
    };
    const breakdown: Record<string, unknown> = {};
    for (const [name, probe] of Object.entries(probes)) {
      breakdown[name] = await page.evaluate(
        ([sql, params]) =>
          window.__dictWasm!.timeSql([{ sql: sql as string, params: params as never }], 3),
        [probe.sql, probe.params] as [string, (string | number)[]],
      );
    }
    const counts = (await page.evaluate(() =>
      window.__dictWasm!.sql([
        { sql: 'SELECT count(*) AS n FROM gloss_fts WHERE gloss_fts MATCH ?', params: ['"to"'] },
        { sql: 'SELECT count(*) AS n FROM gloss_fts WHERE gloss_fts MATCH ?', params: ['"the"'] },
      ]),
    )) as { n: number }[][];
    record.glossBreakdown = {
      note: 'mean ms over 3 runs, one statement per probe, container Chromium',
      postings: { to: counts[0][0].n, the: counts[1][0].n },
      probes: breakdown,
    };
    write();
    expect(counts[0][0].n).toBeGreaterThan(5000);
  });

  /**
   * Criterion 7 — `PRAGMA integrity_check` on the real 43 MB file, timed once.
   *
   * The rule it informs: the open path checks `application_id`, `user_version`
   * and `meta.dict_version`, which touch a handful of pages, and a full
   * integrity check runs only when a later query raises `SQLITE_CORRUPT`. This
   * is the number that makes that a measured choice.
   */
  test('times PRAGMA integrity_check in wasm', async ({ page }) => {
    await openHarness(page);
    expect((await open(page)).ok).toBe(true);
    const report = await page.evaluate(() => window.__dictWasm!.integrityCheck());
    record.integrityCheck = { ms: report.ms, rows: report.rows, bytes: manifest.bytes };
    write();
    expect(report.rows).toEqual(['ok']);
  });

  /**
   * Criterion 3 — a reload fetches nothing.
   *
   * The import is idempotent and keyed by the **whole artifact filename**, so a
   * second load finds the file already in the pool and opens it.
   *
   * **The reload is a real one: nothing closes the store first.** An earlier
   * version called `window.__dictWasm.close()` before reloading, which removed
   * the very race a reload is subject to — `opfs-sahpool` holds an exclusive
   * handle per file and the outgoing document's worker releases its handles
   * asynchronously, so the new document can lose the race and take the
   * in-memory rung. That is why `openOnOpfs` retries the install for a few
   * hundred milliseconds, and this test is what says the retry is enough.
   *
   * **The evidence is counted requests, not a field that defaults to zero.**
   * `report.downloaded` and `report.transfer` are both assigned only inside the
   * "the pool did not have it" branch, so asserting on them twice is asserting
   * one boolean twice. The request counter is independent of anything the
   * worker reports.
   */
  test('a reload reaches ready with zero network bytes for the artifact', async ({ page }) => {
    const fetches: { url: string; after: 'first' | 'reload' }[] = [];
    let phase: 'first' | 'reload' = 'first';
    page.on('request', (request) => {
      if (request.url().endsWith(manifest.file)) fetches.push({ url: request.url(), after: phase });
    });

    await openHarness(page);
    const first = await open(page);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.ok && first.report.imported).toBe(true);
    expect(fetches.filter((one) => one.after === 'first')).toHaveLength(1);

    phase = 'reload';
    await page.reload();
    await expect(page.getByTestId('dict-wasm-harness')).toBeVisible();
    await page.waitForFunction(() => Boolean(window.__dictWasm));
    const openedAt = Date.now();
    const second = await open(page);
    const warmOpenMs = Date.now() - openedAt;
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.ok && second.report.imported, 'the second load re-imported').toBe(false);
    // The rung matters as much as the bytes: a reload that lost the race for the
    // pool's handles would still reach `ready`, in memory, having re-downloaded
    // everything — which is the failure this criterion is really about.
    expect(second.ok && second.report.mode, 'the reload was pushed onto the memory rung').toBe(
      'opfs',
    );

    record.reload = {
      firstLoad: {
        transfer: first.ok ? first.report.transfer : null,
        downloaded: first.ok ? first.report.downloaded : null,
      },
      secondLoad: {
        transfer: second.ok ? second.report.transfer : null,
        downloaded: second.ok ? second.report.downloaded : null,
      },
      artifactRequests: fetches,
      /**
       * The number `data.md` D2 handed D4 and asked for by name: "`open()` at
       * 39.6 ms is the biggest single cost in the layer and it is almost
       * entirely the 14,625-row `chars` read… Measure it in D4 before changing
       * anything." This is that open — the artifact is already in the pool, so
       * nothing is downloaded and what is left is `meta` + `chars` plus the
       * worker's own start-up and the wasm module's instantiation.
       */
      warmOpenMsIncludingWorkerBoot: warmOpenMs,
    };
    write();

    // Three independent statements of the same fact.
    expect(second.ok && second.report.downloaded, 'the second load read artifact bytes').toBe(0);
    expect(second.ok && second.report.transfer, 'the second load has a transfer timing').toBeNull();
    expect(
      fetches.filter((one) => one.after === 'reload'),
      'the reload fetched the artifact again',
    ).toEqual([]);

    const status = await page.evaluate(() => window.__dictWasm!.status());
    expect(status).toEqual({ state: 'ready', version: manifest.dictVersion });
  });

  /**
   * Criterion 4 — an eviction mid-session.
   *
   * Browser storage is reclaimed under disk pressure, and the store has to come
   * back from it rather than spend the session wedged. `evict()` closes the
   * database and unlinks the pool's file — closing first because `unlink` on a
   * file in active use is explicitly undefined behaviour in the VFS's own
   * documentation, and a test built on undefined behaviour proves nothing.
   */
  test('recovers from an eviction: preparing, then ready again', async ({ page }) => {
    await openHarness(page);
    expect((await open(page)).ok).toBe(true);
    const before = await page.evaluate(() => window.__dictWasm!.readingCount('看'));

    // `evict()` leaves the worker with no usable database and does **not**
    // announce it. The next query is where the app finds out, which is the
    // production path: a real eviction arrives as a `SQLITE_IOERR` out of
    // `statement.step()`, and `markLost` is what turns that into a recovery.
    // A test that posted `lost` itself would be testing its own signal.
    await page.evaluate(() => window.__dictWasm!.evict());
    // A *different* character, because the store's result cache would answer
    // `看` from memory without ever reaching the worker — which is a real and
    // desirable property, and a useless assertion.
    await expect(
      page.evaluate(() => window.__dictWasm!.readingCount('行')),
      'the query after an eviction resolved as though nothing had happened',
    ).rejects.toThrow();

    await page.evaluate(() => window.__dictWasm!.settled());
    await page.waitForFunction(() => window.__dictWasm!.status().state === 'ready', undefined, {
      timeout: 180_000,
    });

    const states = await page.evaluate(() => window.__dictWasm!.statuses().map((s) => s.state));
    // Collapsed, because `preparing` repeats once per progress chunk and the
    // criterion is about the transitions, not about how many chunks the import
    // happened to arrive in.
    const collapsed = states.filter((state, index) => state !== states[index - 1]);
    // absent (construct) → preparing → ready (first open) → absent (close) →
    // preparing (reopen) → ready. The criterion is the last three: the store
    // went back through `preparing` and arrived at `ready` rather than throwing.
    expect(collapsed).toEqual(['absent', 'preparing', 'ready', 'absent', 'preparing', 'ready']);
    const after = await page.evaluate(() => window.__dictWasm!.readingCount('看'));
    expect(after).toBe(before);
    record.eviction = {
      // Collapsed for the same reason: eighty `preparing` entries in a record
      // file is noise around the four transitions that matter.
      transitions: collapsed,
      statusCount: states.length,
    };
    write();
  });

  /**
   * Criterion 5 — a second tab falls back, and we record what it costs.
   *
   * `opfs-sahpool` holds an **exclusive** lock per origin, so the second tab
   * cannot open the pool at all and takes rung (a): the whole artifact in the
   * wasm heap, re-fetched. `data.md` D4 says the browser's HTTP cache "should"
   * serve those bytes, and flags that nobody established whether an entry this
   * size survives there. This is the measurement that replaces the guess.
   */
  test('a second tab falls back to memory, and its transfer is measured', async ({ page, context }) => {
    await openHarness(page);
    const first = await open(page);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.ok && first.report.mode).toBe('opfs');

    const second = await context.newPage();
    await openHarness(second);
    const result = await open(second);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.ok && result.report.mode, 'the second tab did not fall back to memory').toBe(
      'memory',
    );
    // It is a working dictionary, not merely a state.
    expect(await second.evaluate(() => window.__dictWasm!.readingCount('看'))).toBeGreaterThan(0);

    // The number this criterion exists for, and it has to come from the worker:
    // the fetch happens there, so the *page's* resource timeline has no entry
    // for the artifact at all and summing it would report a confident zero.
    const transfer = result.ok ? result.report.transfer : null;
    record.secondTab = {
      artifactBytes: manifest.bytes,
      downloadedFromBody: result.ok ? result.report.downloaded : null,
      workerTiming: transfer,
      fromHttpCache: transfer ? transfer.transferSize === 0 : null,
      pageTimeline: await second.evaluate(() => window.__dictWasm!.transferred()),
      note:
        'MEASURED RESULT: the browser HTTP cache did NOT serve the second tab — the whole ' +
        'artifact came off the wire. data.md D4 assumed it would ("should be served with zero ' +
        'network bytes") and said to revisit if measurement showed otherwise; HANDOFF.md carries ' +
        'that. Reading the fields: transferSize 0 alongside a real decodedBodySize would be a ' +
        'cache hit. Caveat on the number: the local dev/preview server sends the artifact ' +
        'uncompressed, so the entry offered to the cache was 43.2 MB rather than the ~15.3 MB ' +
        'brotli a host under content negotiation would send.',
    };
    write();
    expect(transfer, 'the second tab reported no transfer timing at all').not.toBeNull();
    expect(result.ok && result.report.downloaded).toBe(manifest.bytes);
    await second.close();
  });

  /**
   * Criterion 6 — the three ways a download can be wrong, and the two cheap
   * checks that tell them apart.
   *
   * A truncated response is caught by summing the chunk lengths against the
   * manifest's `bytes`; a file that is not this artifact is caught after opening
   * by `application_id` / `user_version` / `meta.dict_version`. Neither costs a
   * hash of 43 MB, which `crypto.subtle.digest`'s one-shot API cannot do without
   * buffering the whole download.
   */
  test('a truncated download fails with reason "download"', async ({ page }) => {
    const bytes = readFileSync(ARTIFACT);
    await page.route(`**${ARTIFACT_URL}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/vnd.sqlite3' },
        body: bytes.subarray(0, 1024 * 1024),
      }),
    );
    await openHarness(page);
    const result = await open(page);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toMatchObject({ state: 'failed', reason: 'download' });
  });

  test('a corrupt file of the right length fails with reason "corrupt"', async ({ page }) => {
    // The real artifact, the real length, with `application_id` (offset 68)
    // zeroed. The SQLite magic at offset 0 is untouched, so `importDb`'s own
    // cursory check passes and the failure is caught where D4 says it is: after
    // the file is open.
    const bytes = readFileSync(ARTIFACT);
    bytes.writeUInt32BE(0, 68);
    const corrupt = join(tmpdir(), `tangram-d4-corrupt-${process.pid}.sqlite`);
    writeFileSync(corrupt, bytes);
    await page.route(`**${ARTIFACT_URL}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/vnd.sqlite3' },
        path: corrupt,
      }),
    );
    await openHarness(page);
    const result = await open(page);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toMatchObject({ state: 'failed', reason: 'corrupt' });
    expect(!result.ok && result.status.message).toContain('application_id');
  });

  test('a valid SQLite database that is not this artifact fails with reason "corrupt"', async ({
    page,
  }) => {
    const other = join(tmpdir(), `tangram-d4-other-${process.pid}.sqlite`);
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE t (x TEXT); INSERT INTO t VALUES (\'not the dictionary\')');
    db.close();
    const otherBytes = readFileSync(other);
    // The manifest is intercepted too, declaring this file's real length — so
    // the byte-count check passes and the *only* thing that can catch it is the
    // header check after opening. Without this, the substitute would be caught
    // as a truncation and the criterion would be testing the wrong check.
    await page.route(`**/${MANIFEST_FILE}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...manifest, bytes: otherBytes.byteLength, sha256: '' }),
      }),
    );
    await page.route(`**${ARTIFACT_URL}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/vnd.sqlite3' },
        path: other,
      }),
    );
    await openHarness(page);
    const result = await open(page);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toMatchObject({ state: 'failed', reason: 'corrupt' });
    // Which check caught it matters, and the message is the only evidence.
    // Neutering the worker's header check leaves this case still reporting
    // `corrupt` — the store's own `SELECT ... FROM meta` fails on a database
    // with no `meta` table — so a status-only assertion would pass against a
    // build that had stopped validating the header at all.
    expect(!result.ok && result.status.message).toContain('application_id');
  });

  /**
   * The fourth wrong-bytes case, which criterion 6 does not enumerate and which
   * this repo can actually produce: **a response that is not a database at all.**
   *
   * The SPA fallback answers a path it does not have with 200 and an HTML
   * document, so a manifest naming a file the deploy did not carry looks exactly
   * like this. Telling the learner the dictionary "could not be imported" would
   * blame their storage and offer the wrong remedy, so the header is checked on
   * the first chunk and the answer is `corrupt`. It must also NOT climb the
   * fallback ladder: bytes that are not a dictionary are not made into one by
   * holding them in the heap, so the artifact is fetched exactly once.
   */
  test('an HTML body where the artifact should be fails with reason "corrupt", once', async ({
    page,
  }) => {
    const fetches: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith(manifest.file)) fetches.push(request.url());
    });
    await page.route(`**${ARTIFACT_URL}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: `<!doctype html><html><body>the SPA fallback</body></html>`,
      }),
    );
    await openHarness(page);
    const result = await open(page);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toMatchObject({ state: 'failed', reason: 'corrupt' });
    expect(!result.ok && result.status.message).toContain('not a SQLite database');
    expect(fetches, 'the in-memory rung was attempted on bytes that cannot be a dictionary').toHaveLength(
      1,
    );
  });

  /**
   * A failed open must not cost the *next* open the OPFS rung.
   *
   * `opfs-sahpool` takes an exclusive handle on each of its files per origin, so
   * a worker that keeps them is a worker that forces the retry onto the
   * in-memory rung — 43 MB of heap and a re-download, for no reason, on the
   * button a learner presses after seeing "that did not work".
   *
   * This pins the **outcome**, not a mechanism, and the distinction was worth
   * measuring: with the explicit release removed, terminating the worker turned
   * out to free the handles quickly enough for this test to pass anyway in the
   * container's Chromium. That is an engine's teardown timing, not a promise, so
   * the worker releases the pool explicitly on every path that stops using it
   * and the main thread asks it to close before terminating — and the assertion
   * here is the thing a learner would notice either way.
   */
  test('a retry after a failed open still gets OPFS, not the memory rung', async ({ page }) => {
    await page.route(`**${ARTIFACT_URL}`, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/vnd.sqlite3' },
        body: readFileSync(ARTIFACT).subarray(0, 1024 * 1024),
      }),
    );
    await openHarness(page);
    const failed = await open(page);
    expect(failed.ok).toBe(false);

    await page.unroute(`**${ARTIFACT_URL}`);
    const retried = await open(page);
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(retried.ok && retried.report.mode, 'the retry was pushed onto the memory rung').toBe(
      'opfs',
    );
  });

  /**
   * The scan-order guarantee, checked on the runner it was changed for.
   *
   * D4 removed `ORDER BY e.rowid` from the gloss candidate query because the
   * sort costs 1,117 ms in wasm, and replaced D3's "not a documented guarantee"
   * with `tests/unit/dict/gloss-order.test.ts` — which runs on `node:sqlite`.
   * That is the wrong SQLite: the removal was motivated by a *different* FTS5
   * build, and the two need not agree. So the same property is asserted here
   * against `@sqlite.org/sqlite-wasm` 3.53.4, for every token whose posting list
   * exceeds the cap, which is the only case where the sorted and unsorted forms
   * can return different rows.
   *
   * (`data.md` D5a/D5b owe the third: the SQLCipher FTS5 behind
   * `@capacitor-community/sqlite`. It is named in HANDOFF.md as theirs.)
   */
  test('FTS5 in wasm scans in ascending rowid order, so the unsorted query is safe', async ({
    page,
  }) => {
    await openHarness(page);
    expect((await open(page)).ok).toBe(true);
    const tokens = ['of', 'to', 'a', 'the', 'in', 'and', 'or', 'idiom', 'plan', 'sun', 'women'];
    const result = (await page.evaluate(async (list) => {
      const out: { token: string; n: number; ascending: boolean; same: boolean }[] = [];
      for (const token of list) {
        const [plain, sorted] = (await window.__dictWasm!.sql([
          {
            sql: 'SELECT e.rowid AS r FROM gloss_fts f JOIN entries e ON e.rowid = f.rowid WHERE f.gloss_fts MATCH ? LIMIT 5000',
            params: [`"${token}"`],
          },
          {
            sql: 'SELECT e.rowid AS r FROM gloss_fts f JOIN entries e ON e.rowid = f.rowid WHERE f.gloss_fts MATCH ? ORDER BY e.rowid LIMIT 5000',
            params: [`"${token}"`],
          },
        ])) as { r: number }[][];
        out.push({
          token,
          n: plain.length,
          ascending: plain.every((row, index) => index === 0 || row.r > plain[index - 1].r),
          same: JSON.stringify(plain.map((row) => row.r)) === JSON.stringify(sorted.map((row) => row.r)),
        });
      }
      return out;
    }, tokens)) as { token: string; n: number; ascending: boolean; same: boolean }[];

    record.wasmScanOrder = result;
    write();
    // Without this the file could be checking a property of an empty result set.
    expect(result.filter((one) => one.n >= 5000).length).toBeGreaterThanOrEqual(5);
    expect(result.filter((one) => !one.ascending)).toEqual([]);
    expect(result.filter((one) => !one.same)).toEqual([]);
  });

  /**
   * Criterion 8 — `decomp.json` is fetched only when a decomposition is asked
   * for.
   *
   * 0.92 MB is not first-load budget, and the licence boundary is why it is a
   * separate file in the first place: Make Me a Hanzi is LGPL-3.0-or-later and
   * never enters the CC BY-SA artifact.
   */
  test('decomp.json is not fetched until a decomposition is requested', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/decomp.json') requested.push(request.url());
    });
    await openHarness(page);
    expect((await open(page)).ok).toBe(true);
    await page.evaluate(() => window.__dictWasm!.search('打算'));
    expect(await page.evaluate(() => window.__dictWasm!.decompFetched())).toBe(false);
    expect(requested, 'decomp.json was fetched before anything asked for it').toEqual([]);

    const characters = (await page.evaluate(() => window.__dictWasm!.decompose('打算打'))) as {
      char: string;
      entry: unknown;
    }[];
    expect(characters.map((one) => one.char)).toEqual(['打', '算']);
    expect(characters[0].entry).not.toBeNull();
    await expect.poll(() => requested.length).toBe(1);

    // Twice asked for, once fetched.
    await page.evaluate(() => window.__dictWasm!.decompose('算'));
    expect(requested.length).toBe(1);
  });
});
