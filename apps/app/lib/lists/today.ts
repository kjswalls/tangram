/**
 * Today (PLAN.md §3.3, §4 P3): the counts on `/`, and the one place the queue's
 * decisions are turned into rows.
 *
 * **Since core.md C7 there are two modes, and the caller says which.**
 * `introduce: true` (the default) is what the Practice session does: it draws
 * the day's new words, creates their cards and charges
 * `settings.introduced[dayKey]`. `introduce: false` is what Today does: it
 * reports the same numbers and creates nothing, so opening the app costs the
 * learner none of the day's allowance.
 *
 * Both modes read the spine, because a report that does not look cannot be
 * true; only the introducing one writes. Reloading is free either way: the
 * cards already exist, the counter already reflects them, and the draw asks for
 * `cap − already introduced` more, which is zero.
 *
 * `wave-zero.md` §9 is why: **Practice is the only place any of the three is
 * reached**, so it is the only place that may spend the day.
 */

import type { CardRow, ListRow, SettingsRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { collectDrawCandidates } from '@/lib/lists/draw';
import { getEntrySource, type EntrySource } from '@/lib/lists/entry-source';
import { introduceCards } from '@/lib/lists/introduce';
import { buildQueue, type Queue } from '@/lib/lists/queue';
import { ensureSystemLists } from '@/lib/lists/system-lists';

export interface TodayInput {
  repo: Repository;
  now?: number;
  source?: EntrySource;
  /** Set false to report the counts without creating anything (tests, previews). */
  introduce?: boolean;
}

export interface TodaySummary {
  now: number;
  settings: SettingsRow;
  lists: ListRow[];
  queue: Queue;
  due: CardRow[];
  newCards: CardRow[];
  /** Cards this call brought into being. */
  created: CardRow[];
  dueCount: number;
  /** New cards that already exist. */
  newCount: number;
  /**
   * What a session will actually offer: the new cards that exist **plus** the
   * words today's cap still allows *and the spine can actually supply*
   * (docs/plans/core.md C7; corrected by C8's review).
   *
   * The merge moved the introduction into the Practice session, so Today reports
   * rather than creates — and `newCount` alone reads 0 on a fresh database while
   * the cap is holding ten words for the learner.
   *
   * **It is not `drawLimit`.** The cap is an allowance, not an inventory: a
   * learner whose spine bands are exhausted, deactivated or filtered down has a
   * `drawLimit` of ten and nothing to spend it on, and reporting ten put "10 new
   * words to learn" on Today every day over a session that introduced none. So
   * the reporting path now *collects* the candidates too — a read, with no
   * writes and no charge to the counter — and reports the smaller of the two.
   *
   * **Deliberately not called `newAvailable`.** `Queue.newAvailable` already
   * exists, means something similar and computes something different, and both
   * are reachable from a `TodaySummary` a caller is holding
   * (`summary.newToOffer` vs `summary.queue.newAvailable`). Two names, because
   * picking the wrong one of two identical names is silent.
   */
  newToOffer: number;
  introducedToday: number;
  newPerDay: number;
  /**
   * The dictionary was unreachable, so no new words could be drawn. Everything
   * else on the page is still true: a data outage must not empty the queue.
   */
  drawError?: string;
}

/**
 * One run at a time per repository: React can mount Today twice (StrictMode, a
 * fast re-navigation) and two concurrent draws would each see an empty card
 * table and charge the counter for the same ten words.
 *
 * **The mode is part of the key, and it was not.** Since core.md C7 there are
 * two callers with two different jobs: `components/screens/today.tsx` *reports*
 * (`introduce: false`) and `lib/stores/review.ts` *introduces*. Keyed on the
 * repository alone, a reporting run already in flight satisfied an introducing
 * caller — so pressing "Start practice" while Today's own load was still
 * running handed the session a summary that had created nothing, and the day's
 * new words silently did not appear. That is the exact path the button takes,
 * and the load is slow on a cold database because it materialises the band
 * lists.
 *
 * The rule is asymmetric, because the two jobs are: a **reporting** caller may
 * take an introducing run's result (it is the same numbers, plus the rows an
 * introducing run created), but an **introducing** caller may never take a
 * reporting one.
 */
interface InFlightRun {
  /** Whether this run will create the day's new words. */
  introduce: boolean;
  promise: Promise<TodaySummary>;
}

const inFlight = new WeakMap<Repository, InFlightRun>();

async function run(input: TodayInput): Promise<TodaySummary> {
  const now = input.now ?? Date.now();
  const source = input.source ?? getEntrySource();
  const repo = input.repo;

  const lists = await ensureSystemLists(repo);
  const settings = await repo.getSettings();
  const cards = await repo.allCards();

  const first = buildQueue({ now, cards, settings });

  let created: CardRow[] = [];
  let after = settings;
  let drawError: string | undefined;
  let drew = false;
  /**
   * How many words the spine can actually supply right now, as against how many
   * the day's cap would allow. `undefined` means nobody asked — the cap is
   * already spent, so the question does not arise.
   *
   * **The collection runs in both modes.** It is a read; only `introduceCards`
   * below writes. Running it on the reporting path is what lets Today say a
   * true number and what revives its "No new words could be drawn" banner,
   * which was dead code from the moment reporting stopped attempting a draw.
   */
  let drawable: number | undefined;
  if (first.drawLimit > 0) {
    drew = input.introduce !== false;
    try {
      const candidates = await collectDrawCandidates({
        repo,
        settings,
        lists,
        limit: first.drawLimit,
        cards,
        source,
      });
      drawable = candidates.length;
      if (input.introduce !== false && candidates.length > 0) {
        // Read after the draw, not before: the source only knows the snapshot
        // once it has fetched something from it.
        const dictVersion = source.dictVersion?.();
        const outcome = await introduceCards(repo, candidates, {
          now,
          source,
          settings,
          // The draw has just read the dictionary, so the source knows which
          // snapshot these rows came from; without it the card records
          // 'unknown' and can never be re-checked against a rebuilt dictionary.
          ...(dictVersion === undefined ? {} : { dictVersion }),
        });
        created = outcome.created;
        after = outcome.settings;
      }
    } catch (error) {
      // `data/` is missing or the route is down. The due cards are local and
      // still valid, so the page renders with a note instead of an error.
      drawError = error instanceof Error ? error.message : String(error);
    }
  }

  // The card table is re-read whenever a draw ran, rather than assumed to be
  // what was read plus what this call created. A second tab introducing the
  // same words a moment earlier leaves `created` empty here — its cards are
  // today's all the same, and a page reporting "0 new" over four rows in the
  // database would send the learner to a review it says is empty.
  const settled = drew ? await repo.allCards() : cards;
  const queue = buildQueue({ now, cards: settled, settings: after });

  return {
    now,
    settings: after,
    lists,
    queue,
    due: queue.due,
    newCards: queue.newCards,
    created,
    dueCount: queue.due.length,
    newCount: queue.newCards.length,
    // `drawLimit` is 0 once a draw has run and charged the counter, so this is
    // the same total whether or not this call introduced anything.
    // `drawable` is measured **before** the draw, so on an introducing run the
    // words it counted are now rows in `newCards`; counting them again would
    // make the session report double what it offered. What is left is what the
    // spine could supply less what this call turned into cards, and the cap is
    // still the ceiling.
    newToOffer:
      queue.newCards.length +
      Math.min(
        queue.drawLimit,
        drawable === undefined ? queue.drawLimit : Math.max(0, drawable - created.length),
      ),
    introducedToday: queue.introducedToday,
    newPerDay: queue.newPerDay,
    ...(drawError === undefined ? {} : { drawError }),
  };
}

export function loadToday(input: TodayInput): Promise<TodaySummary> {
  const introduce = input.introduce !== false;
  const pending = inFlight.get(input.repo);
  if (pending && (!introduce || pending.introduce)) return pending.promise;

  const started = run(input).finally(() => {
    // Identity-checked: an introducing run may have replaced a reporting one
    // while that one was still going, and the loser's `finally` must not
    // delete the winner's entry — which would let a *second* introducing run
    // start beside the first, and charge the day's counter twice.
    if (inFlight.get(input.repo)?.promise === started) inFlight.delete(input.repo);
  });
  inFlight.set(input.repo, { introduce, promise: started });
  return started;
}
