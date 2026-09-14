/**
 * The entry point: read the environment, build the app, listen, and stop
 * cleanly.
 *
 * Nothing but this file touches `process`. Everything that decides behaviour is
 * a value passed into `buildApp`, which is what makes the app testable without
 * a socket and what stops a future phase reaching for `process.env` from inside
 * a handler.
 */
import { serve } from '@hono/node-server';

import { buildApp } from './app.ts';
import { readBuildInfo } from './build-info.ts';
import { readConfig } from './config.ts';
import { createLogger } from './log.ts';

/**
 * How long a shutdown may take before connections are cut.
 *
 * B1's ask deadline is 30 s, three times a naive 10 s drain, so this is
 * configurable rather than a literal: a platform that gives the process longer
 * than its own grace period should use it, and one that does not should say so
 * in the exit code rather than exit 0 on a shutdown that dropped requests.
 */
const DRAIN_MS = Number(process.env.TANGRAM_DRAIN_MS) > 0 ? Number(process.env.TANGRAM_DRAIN_MS) : 35_000;

const startedAt = Date.now();
const config = readConfig();
const logger = createLogger();
const app = buildApp({ startedAt, logger, exposeErrors: !config.production });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  // The sha goes in the boot line for the same reason it is on /health: so a
  // log and a deployment can be matched to a commit. `readBuildInfo` reads no
  // secret, and nothing else about the environment is printed.
  logger.info('listening', {
    host: config.host,
    port: info.port,
    sha: readBuildInfo().sha,
    production: config.production,
  });
});

/**
 * SIGTERM is how every container runtime in the running for B0 asks a process
 * to go away, and a process that ignores it is killed mid-request. B7 owns the
 * operational surface; this much belongs here because the alternative is a
 * rollback drill that drops connections.
 */
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal, drainMs: DRAIN_MS });
    server.close(() => {
      logger.info('drained');
      process.exit(0);
    });
    // A connection that will not drain must not hold the deploy open forever —
    // but a forced exit is NOT a clean one. Exiting 0 silently here makes every
    // deploy that cut a 30 s ask look identical to one that drained, which is
    // the opposite of what this handler is for.
    setTimeout(() => {
      logger.error('forced shutdown, connections still open', { drainMs: DRAIN_MS });
      process.exit(75);
    }, DRAIN_MS).unref();
  });
}

/**
 * A bind failure is an `error` event on the server, not a rejected promise. Left
 * unhandled it is a bare stack trace and a non-obvious exit; a port already in
 * use is the commonest deploy misconfiguration there is, so it says so.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  logger.error('failed to listen', { host: config.host, port: config.port, code: error.code, error });
  process.exit(74);
});
