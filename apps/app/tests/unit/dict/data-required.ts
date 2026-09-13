/**
 * The dictionary tests assert against the real generated data, so a missing
 * build has to fail loudly with the command that fixes it — not skip, which
 * would let a broken generator pass silently.
 *
 * It checks the SQLite artifact as well as `dict.json`, and by name: from D2
 * onward a store test against a missing or stale artifact would otherwise fail
 * with a raw SQLite error instead of "run `pnpm data`" (docs/plans/data.md D1).
 * The artifact's name comes from the manifest rather than from a pattern,
 * because a `.sqlite` left over from an older `SCHEMA_VERSION` is exactly the
 * stale file this is meant to catch.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { MANIFEST_FILE, SCHEMA_VERSION, type DictManifest } from '@/lib/dict/artifact';
import { dataDir } from '@/lib/dict/load';

const RUN = 'run `pnpm data` before `pnpm test`';

export function requireDictData(): void {
  const path = resolve(dataDir(), 'dict.json');
  if (!existsSync(path)) throw new Error(`${path} is missing — ${RUN}`);
}

/** The `.sqlite` the manifest names, present and the length the manifest claims. */
export function requireDictArtifact(): DictManifest {
  requireDictData();
  const manifestPath = resolve(dataDir(), MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath} is missing — ${RUN}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DictManifest;
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${manifestPath} is schema ${manifest.schemaVersion}, this tree is ${SCHEMA_VERSION} — ${RUN}`,
    );
  }
  const artifact = resolve(dataDir(), manifest.file);
  if (!existsSync(artifact)) throw new Error(`${artifact} is missing — ${RUN}`);
  const bytes = statSync(artifact).size;
  if (bytes !== manifest.bytes) {
    throw new Error(`${artifact} is ${bytes} bytes, the manifest says ${manifest.bytes} — ${RUN}`);
  }
  return manifest;
}

/** The absolute path of the artifact, for a test that opens it. */
export function dictArtifactPath(): string {
  return resolve(dataDir(), requireDictArtifact().file);
}
