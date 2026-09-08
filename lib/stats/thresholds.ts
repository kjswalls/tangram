/**
 * How much data a number needs before it is allowed on screen (Phase 8, the
 * retention dashboard).
 *
 * The line these draw is between a **count** and a **rate**. A count is exact
 * at any size: "you did four reviews on Tuesday" is true whether the database
 * holds four reviews or forty thousand, so the workload and maturity charts
 * have no threshold at all — they say what is there, and when there is nothing
 * they say that. A *rate* estimated from a handful of trials is noise wearing a
 * percent sign: 3 of 4 is "75%" and means nothing, and a calibration dot drawn
 * over eleven reviews would send the optimizer chasing sampling error. Those
 * get a floor, and below it the panel says how far off it is.
 */

/**
 * True retention needs this many reviews *of cards in the Review state* before
 * it is shown. At 30 the 95% confidence interval on a 90% rate is roughly
 * ±11 points — wide, but the number has stopped flipping on a single Again.
 */
export const MIN_RETENTION_REVIEWS = 30;

/**
 * Calibration needs an order of magnitude more, because it is not one rate but
 * ten: the reviews have to spread across the predicted-recall deciles before
 * any of them holds enough to plot.
 */
export const MIN_CALIBRATION_REVIEWS = 100;

/**
 * And a single decile is not drawn below this. A dot at "predicted 75%,
 * observed 100%" over 3 reviews is not evidence of anything; leaving it out is
 * the difference between an honest chart and a confident-looking one. The
 * reviews in a skipped bucket are counted and reported, never silently dropped.
 */
export const MIN_CALIBRATION_BUCKET_REVIEWS = 10;

/** The span both the workload chart and the "last 30 days" retention use. */
export const WINDOW_DAYS = 30;
