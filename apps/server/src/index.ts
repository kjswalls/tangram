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
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    // A connection that will not drain must not hold the deploy open forever.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
