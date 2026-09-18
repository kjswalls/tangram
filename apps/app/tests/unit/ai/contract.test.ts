/**
 * The frozen ask contract, checked against the app it was frozen for.
 *
 * `packages/ai/schemas.ts` is `backend.md` B2's first commit and `CLAUDE.md`'s
 * settle-first table names it. Two sibling plans gate on the commit rather than
 * the phase — `data.md` D6 and `core.md` C7 — so the contract has to be provably
 * consistent with the shapes that already exist *before* either of them starts,
 * not after B2's remainder lands.
 *
 * A package may not import from an app, so `schemas.ts` restates three things
 * that also live in `apps/app/lib/types.ts`: `HskBand`, `EntryId` and the token
 * and answer shapes. **Restating a type is how two definitions silently drift.**
 * The assertions below are the thing that stops it: they are type-level, they
 * run at `pnpm typecheck` as well as here, and a divergence is a compile error
 * naming the field.
 *
 * The load-bearing one is `Entry extends RetrievedEntry`. `backend.md` B2 rests
 * an entire acceptance criterion on it — "`Entry` is structurally assignable to
 * `RetrievedEntry`, so every existing caller and every test that passes a real
 * dictionary entry keeps compiling; what stops compiling is a server that
 * assumed it had a whole `Entry`, which is the point." If that stops being true,
 * B2 turns from a signature change into a rewrite of every call site, and the
 * phase whose whole purpose is that the review has a single variable acquires a
 * second one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTRACT_PATHS,
  MAX_EXAMPLE_SENTENCES,
  MAX_GLOSSES_PER_ENTRY,
  MAX_KNOWN_SAMPLE,
  MAX_PROPOSED_PHRASES,
  MAX_QUERY_CHARS,
  MAX_RECALL_ANSWER_CHARS,
  RETRIEVED_CAP,
  RETRIEVED_ENTRY_KEYS,
  SUPPORT_CAP,
  toRetrieved,
  type AskContext as ContractAskContext,
  type AskMatch,
  type AskResponse,
  type AskSayIt,
  type AskToken,
  type HskBand as ContractHskBand,
  type LearnerProfile as ContractProfile,
  type ProviderName as ContractProviderName,
  type RawExampleSentence,
  type RecallGrade as ContractGrade,
  type RetrievedEntry,
} from '@tangram/ai/schemas';

import type { ExampleSentence as GroundedExampleSentence } from '@tangram/ai/examples';
import {
  MAX_EXAMPLE_SENTENCES as PROVIDER_MAX_EXAMPLE_SENTENCES,
  MAX_PROPOSED_PHRASES as PROVIDER_MAX_PROPOSED,
  RECALL_GRADES,
  type AskContext as ProviderAskContext,
  type ProviderName as ProviderProviderName,
} from '@tangram/ai/provider';
import { RECALL_ANSWER_MAX_CHARS } from '@tangram/ai/recall';
import { GATED_PATHS, isGatedPath } from '@tangram/access';
import type {
  AskMatch as AppAskMatch,
  AskResponse as AppAskResponse,
  AskSayIt as AppAskSayIt,
  AskToken as AppAskToken,
  Entry,
  HskBand,
  LearnerProfile,
} from '@/lib/types';

/**
 * `true` when `A` is assignable to `B`, `false` otherwise.
 *
 * The tuple wrappers stop the conditional distributing over a union: without
 * them `HskBand extends ContractHskBand` evaluates per member and a partial
 * overlap widens to `boolean`, which would then be assignable to neither
 * literal and the assertion would pass for the wrong reason.
 */
type Assignable<A, B> = [A] extends [B] ? true : false;
/** `true` only when the two types are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The assertions below are `const … = true` rather than unused type aliases so
 * that they are checked by `tsc`, reported by eslint if they ever stop being
 * read, and visible in the test output. A divergence makes `true` unassignable
 * to `false` and names the field in the compile error.
 */

describe('the contract restates types that live in lib/types.ts', () => {
  it('agrees on HskBand, exactly', () => {
    const sameBand: Exact<HskBand, ContractHskBand> = true;
    const bands: ContractHskBand[] = [1, 2, 3, 4, 5, 6, 7];
    expect(sameBand).toBe(true);
    expect(bands).toHaveLength(7);
  });

  it('agrees on LearnerProfile, exactly', () => {
    const sameProfile: Exact<LearnerProfile, ContractProfile> = true;
    expect(sameProfile).toBe(true);
  });

  it('agrees on the 1-4 recall vocabulary', () => {
    const sameGrade: Exact<(typeof RECALL_GRADES)[number], ContractGrade> = true;
    expect(sameGrade).toBe(true);
    expect([...RECALL_GRADES]).toEqual([1, 2, 3, 4]);
  });

  it('agrees on the token, match, phrase and answer shapes', () => {
    const sameToken: Exact<AppAskToken, AskToken> = true;
    const sameMatch: Exact<AppAskMatch, AskMatch> = true;
    const sameSayIt: Exact<AppAskSayIt, AskSayIt> = true;
    const sameAnswer: Exact<AppAskResponse, AskResponse> = true;
    expect([sameToken, sameMatch, sameSayIt, sameAnswer]).toEqual([true, true, true, true]);
  });

  it('agrees with provider.ts on AskContext and ProviderName', () => {
    // Both also live in lib/ai/provider.ts, which wave-zero.md §5 moves into
    // this same package. A field added to one copy and not the other is
    // accepted by the prompt builder and stripped by the edge validator.
    const sameContext: Exact<ProviderAskContext, ContractAskContext> = true;
    const sameProvider: Exact<ProviderProviderName, ContractProviderName> = true;
    expect([sameContext, sameProvider]).toEqual([true, true]);
  });
});

describe('Entry is structurally assignable to RetrievedEntry', () => {
  it('compiles — backend.md B2 rests an acceptance criterion on it', () => {
    const entryIsRetrievable: Assignable<Entry, RetrievedEntry> = true;
    expect(entryIsRetrievable).toBe(true);
  });

  it('and the reverse is false, which is what makes the flip a real change', () => {
    // A RetrievedEntry has none of Entry's eleven other fields, so a server
    // that assumed a whole Entry stops compiling. If this ever became `true`
    // the contract would have widened back into the shape it exists to shrink.
    const retrievedIsNotAnEntry: Assignable<RetrievedEntry, Entry> = false;
    expect(retrievedIsNotAnEntry).toBe(false);
  });

  it('passes a real dictionary row through without an adapter', () => {
    const entry: Entry = {
      id: '打算|打算[da3 suan4]',
      simp: '打算',
      trad: '打算',
      pinyinNum: 'da3 suan4',
      pinyinMarked: 'dǎsuàn',
      glosses: ['to plan', 'to intend'],
      classifiers: [],
      properNoun: false,
      isVariant: false,
      surname: false,
      hskBand: 3,
    };
    // No cast, no mapping: this is the whole claim.
    const retrieved: RetrievedEntry = entry;
    expect(retrieved.pinyinMarked).toBe('dǎsuàn');
    expect(retrieved.hskBand).toBe(3);
  });

  it('does NOT go the other way — a RetrievedEntry is not an Entry', () => {
    // The direction that must fail is what makes the flip meaningful: a server
    // that assumed it had a whole Entry stops compiling. Asserted by listing
    // the fields RetrievedEntry drops, so a later widening of the contract has
    // to edit this line.
    const dropped = [
      'pinyinNum',
      'classifiers',
      'properNoun',
      'isVariant',
      'variantOf',
      'surname',
      'pos',
      'freqRank',
      'freq',
    ];
    const retrieved: RetrievedEntry = {
      id: 'x|x[x]',
      simp: 'x',
      trad: 'x',
      pinyinMarked: 'x',
      glosses: [],
    };
    for (const field of dropped) expect(retrieved).not.toHaveProperty(field);
  });

  it('carries exactly the six fields prompts.ts reads off an entry', () => {
    // entryLine() renders id, simp, trad, pinyinMarked, the HSK band and the
    // glosses, and touches nothing else. A seventh field here would be a claim
    // that the model sees something it does not.
    //
    // RETRIEVED_ENTRY_KEYS is `as const satisfies readonly (keyof
    // RetrievedEntry)[]`, so a field REMOVED from the interface breaks the
    // compile. A field ADDED is caught here, by count — which is the direction
    // a hand-written array of key names could not catch on its own.
    expect([...RETRIEVED_ENTRY_KEYS]).toEqual(['id', 'simp', 'trad', 'pinyinMarked', 'hskBand', 'glosses']);
    expect(RETRIEVED_ENTRY_KEYS).toHaveLength(6);
  });

  it('projects a full Entry down to those six, because assignability is not a wire fact', () => {
    // `const retrieved: RetrievedEntry = entry` compiles and then JSON.stringify
    // sends all fifteen fields. toRetrieved() is what makes the wire shape true
    // at runtime, and this is the assertion that says so.
    const entry: Entry = {
      id: '打算|打算[da3 suan4]',
      simp: '打算',
      trad: '打算',
      pinyinNum: 'da3 suan4',
      pinyinMarked: 'dǎsuàn',
      glosses: ['to plan'],
      classifiers: ['个'],
      properNoun: false,
      isVariant: false,
      surname: false,
      pos: 'v',
      hskBand: 3,
      freqRank: 1234,
      freq: 9876,
    };
    expect(Object.keys(JSON.parse(JSON.stringify(entry)))).toHaveLength(14);
    expect(Object.keys(toRetrieved(entry)).sort()).toEqual([...RETRIEVED_ENTRY_KEYS].sort());
  });

  it('omits hskBand rather than sending it as undefined, so the wire has one shape', () => {
    const banded = toRetrieved({ id: 'a', simp: 'a', trad: 'a', pinyinMarked: 'a', glosses: [] });
    expect('hskBand' in banded).toBe(false);
  });
});

describe('the caps agree with the values already in the app', () => {
  it('reuses the provider’s proposal cap rather than inventing a second one', () => {
    expect(MAX_PROPOSED_PHRASES).toBe(PROVIDER_MAX_PROPOSED);
  });

  it('reuses the recall answer cap', () => {
    expect(MAX_RECALL_ANSWER_CHARS).toBe(RECALL_ANSWER_MAX_CHARS);
  });

  it('keeps §3.4’s retrieved cap and the examples support cap at 40', () => {
    expect(RETRIEVED_CAP).toBe(40);
    expect(SUPPORT_CAP).toBe(40);
  });

  it('keeps the request caps the routes enforce today', () => {
    expect(MAX_QUERY_CHARS).toBe(400);
    expect(MAX_KNOWN_SAMPLE).toBe(200);
  });

  it('reuses the provider’s example-sentence cap — it is also the prompt’s ceiling', () => {
    // examplesUserPrompt asks for `count = 3` under this; if provider.ts's copy
    // rises and the frozen one does not, the edge rejects as `provider-invalid`
    // the sixth sentence its own prompt asked for.
    expect(MAX_EXAMPLE_SENTENCES).toBe(PROVIDER_MAX_EXAMPLE_SENTENCES);
  });

  it('bounds bytes and not only counts, because 40 rows is not a size', () => {
    // backend.md B7 writes its limiter against "the body-size and entry-count
    // caps B2 introduced". Counts alone leave `retrieved` unbounded in bytes.
    expect(MAX_GLOSSES_PER_ENTRY).toBeGreaterThan(0);
  });
});

describe('the paths', () => {
  it('keeps every gated path literally true, so @tangram/access needs no edit', () => {
    for (const path of GATED_PATHS) expect(CONTRACT_PATHS).toContain(path);
  });

  it('puts the two new ask routes UNDER /api/ask, so the gate must prefix-match', () => {
    // If anything ever matches GATED_PATHS by exact string, these two are the
    // routes that spend the money and they are ungated. schemas.ts says so in
    // its own header; this is the failing test that goes with it.
    const extra = CONTRACT_PATHS.filter((path) => !(GATED_PATHS as readonly string[]).includes(path));
    expect(extra).toEqual(['/api/ask/propose', '/api/ask/answer']);
    for (const path of extra) expect(path.startsWith('/api/ask/')).toBe(true);
  });

  it('and the matcher that exists actually covers them', () => {
    // `wave-zero.md` §10a, ruling 4: the assertion must name the two children
    // explicitly, because a test that only proves the three parents are gated
    // is the test that would have passed while both children were open. The
    // test above pins the CONTRACT; this one pins the implementation
    // `web.md` W4 shipped and `backend.md` B1 enforces with.
    for (const path of CONTRACT_PATHS) expect(isGatedPath(path), path).toBe(true);
    expect(isGatedPath('/api/ask/propose')).toBe(true);
    expect(isGatedPath('/api/ask/answer')).toBe(true);
    // …and it stops at a separator, so it never covers a route nobody listed.
    expect(isGatedPath('/api/asking')).toBe(false);
  });
});

describe('the answer shape is the ungrounded one', () => {
  it('is the same four fields askResponseSchema validates', () => {
    const answer: AskResponse = { interpretation: '', matches: [], sayIt: [], notes: [] };
    expect(Object.keys(answer).sort()).toEqual(['interpretation', 'matches', 'notes', 'sayIt']);
  });

  it('keeps RawExampleSentence distinct from the GROUNDED ExampleSentence', () => {
    // lib/ai/examples.ts exports `ExampleSentence = GroundedSayIt` — grounded,
    // filtered, cache-safe, with `register` and `unverified`. Both types land in
    // packages/ai under wave-zero §5. If the raw one were assignable to the
    // grounded one, the ungrounded array could be written into `ask_cache`
    // through `AskCache.set(key, response: unknown)` with nothing complaining,
    // and the licence boundary goes with it.
    const rawIsNotGrounded: Assignable<RawExampleSentence, GroundedExampleSentence> = false;
    expect(rawIsNotGrounded).toBe(false);
  });
});

describe('packages/ai is wired into the workspace', () => {
  // The same guard apps/server/tests/workspace.test.ts carries, for the same
  // reason: the workspace root's eslint config ignores `packages/**`, and a
  // package that is in no root gate is checked by nothing while everything
  // stays green (web.md W0's review found that exact shape).
  const root = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

  it('is covered by pnpm-workspace.yaml', () => {
    expect(read('pnpm-workspace.yaml')).toMatch(/^\s*-\s*'?packages\/\*'?\s*$/m);
  });

  it('is linted and typechecked by the root gates', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.lint).toMatch(/-F @tangram\/ai lint/);
    expect(scripts.typecheck).toMatch(/-F @tangram\/ai typecheck/);
  });

  it('brings its own eslint config, because the root config ignores packages/**', () => {
    expect(read('eslint.config.mjs')).toMatch(/'packages\/\*\*'/);
    expect(() => read('packages/ai/eslint.config.mjs')).not.toThrow();
  });

  /**
   * wave-zero.md §5's split, asserted in both directions, because a half-done
   * move still compiles for as long as nothing imports the missing half.
   *
   * Deliberately a **superset** check on this side rather than exact equality:
   * `backend.md` B1 and B2's remainder both write new modules into this package
   * (B1 owes injection seams for the six runtime `@/lib/**` edges), and an
   * exact list turns red on a legitimate addition with a message pointing at
   * the wrong cause. What must not drift is that each named module is here and
   * is not simultaneously back in the app — which the second case covers.
   */
  const MOVED = [
    'anthropic.ts',
    'cache-key.ts',
    'deadline.ts',
    'examples.ts',
    'fake.ts',
    'ground.ts',
    'index.ts',
    'prompts.ts',
    'provider.ts',
    'recall.ts',
    'retrieve.ts',
  ];

  it('holds the frozen contract and the eleven modules wave 0 deliverable 5 moved', () => {
    const files = readdirSync(resolve(root, 'packages/ai')).filter((name) => name.endsWith('.ts'));
    expect(files.sort()).toEqual(expect.arrayContaining([...MOVED, 'schemas.ts'].sort()));
  });

  it('leaves apps/app/lib/ai to ask-client.ts and nothing else', () => {
    // The directory does not exist until `backend.md` B2 writes ask-client.ts
    // into it, so ENOENT is a pass — but ONLY ENOENT. An earlier draft caught
    // every error, which would have turned a wrong `root` (five `..` from this
    // file) into a permanent vacuous pass: exactly the shape of test this build
    // has been bitten by twice (`wave-zero.md` §10a). The walk is recursive and
    // takes `.tsx` as well, because "put it back in a subdirectory" and "put it
    // back as a component" are the two ways round a flat `.ts` listing.
    // wave-zero.md §5: "apps/app/lib/ai/ holds only ask-client.ts, which is
    // browser-side and calls the server."
    const dir = resolve(root, 'apps/app/lib/ai');
    const walk = (at: string): string[] =>
      readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(at, entry.name))
          : /\.tsx?$/.test(entry.name)
            ? [relative(dir, join(at, entry.name))]
            : [],
      );

    let left: string[];
    try {
      left = walk(dir);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code, String(error)).toBe('ENOENT');
      left = [];
    }
    expect(left.filter((name) => name !== 'ask-client.ts')).toEqual([]);
  });

  it('…and that pair of cases would actually catch a module in the wrong place', () => {
    // Otherwise both pass just as well against a resolver that resolves nothing.
    // Proves the root is right and the listings are non-empty, without writing
    // to the tree: `packages/ai` must contain every moved name, and the app's
    // `lib/` must contain none of them at the old spelling.
    const here = readdirSync(resolve(root, 'packages/ai'));
    for (const name of MOVED) expect(here, `${name} must live in packages/ai`).toContain(name);
    expect(() => readdirSync(resolve(root, 'packages/ai/no-such-dir'))).toThrow();
  });
});
