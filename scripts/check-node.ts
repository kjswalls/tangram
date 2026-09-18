/**
 * The Node floor, checked precisely — the replacement for `engine-strict`.
 *
 * `.npmrc` used to carry `engine-strict=true`, on the reasoning that `engines`
 * is documentation unless something enforces it and this repository has no CI.
 * The reasoning was right and the instrument was too blunt: `engine-strict`
 * honours **every** publisher's `engines`, including the ones that are not
 * requirements at all.
 *
 * `cedict-json@1.3.20251213` declares `engines: { node: "22" }` — a bare major,
 * so Node 24 is rejected. The package is 16 MB of `cedict.json` plus an 89-byte
 * re-export; it has no Node API usage, and `scripts/build-data.ts` never even
 * imports it (it calls `require.resolve` to find the directory and reads the
 * JSON off disk). The pin is the publisher recording their own dev box. It is
 * also the **only** one of the 318 `engines.node` declarations in the lockfile
 * that Node 24 fails, and it is what made every Vercel build fail: React Router
 * needs >= 22.22, Vercel's 22.x image is below that, and Node 24 was refused by
 * this pin, so no available Node satisfied both.
 *
 * So the check moved here, where it can say what is actually required. The real
 * floor is React Router's own — `react-router@8.3.1` declares `>=22.22.0` — and
 * `tests/unit/build/node-floor.test.ts` asserts this constant still matches what
 * the installed package declares, so an upgrade cannot silently move it.
 */
export const NODE_FLOOR = '22.22.0';

/** `[major, minor, patch]`, ignoring any prerelease or build suffix. */
function parse(version: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`cannot read a version out of ${version!}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function satisfiesFloor(version: string, floor: string = NODE_FLOOR): boolean {
  const [a, b, c] = parse(version);
  const [x, y, z] = parse(floor);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

export function floorMessage(version: string): string {
  return [
    `This repository needs Node >= ${NODE_FLOOR}, and this is ${version}.`,
    '',
    "The floor is react-router's own: it declares engines.node >=22.22.0, and the",
    'app will not run on less. Node 24 is fine and is what a Vercel build uses.',
    '',
    'nvm: `nvm install 22.22 && nvm use 22.22`, or use Node 24.',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!satisfiesFloor(process.version)) {
    console.error(floorMessage(process.version));
    process.exit(1);
  }
}
