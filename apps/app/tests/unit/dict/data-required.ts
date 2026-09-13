/**
 * The dictionary tests assert against the real generated data, so a missing build
 * has to fail loudly with the command that fixes it — not skip, which would let a
 * broken generator pass CI silently.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { dataDir } from '@/lib/dict/load';

export function requireDictData(): void {
  const path = resolve(dataDir(), 'dict.json');
  if (!existsSync(path)) {
    throw new Error(`${path} is missing — run \`pnpm data\` before \`pnpm test\``);
  }
}
