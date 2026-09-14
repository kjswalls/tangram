/**
 * `pnpm font:fetch` — vendor the candidate font binaries and their licences
 * (docs/plans/core.md C0, prerequisite 1).
 *
 * Neither the binaries nor a system copy of them exists in this container —
 * `fc-list` shows WenQuanYi Zen Hei and IPA Gothic and nothing else that is a
 * candidate — so `pnpm font:coverage` cannot run until this has. A fetch script
 * rather than 43 MB of committed binaries, per C0's own preference; the
 * licences ARE committed, because the OFL requires the licence to travel with
 * the font.
 *
 * Idempotent. A face whose file is present and whose sha256 matches the
 * manifest is skipped. A face whose digest does NOT match is an error, not a
 * silent overwrite: `scripts/fonts.ts` pins the bytes the recorded coverage
 * numbers were measured over, and an upstream that moved underneath them is
 * exactly the thing that would make those numbers quietly wrong. Pass
 * `--accept-new-digest` to take the new bytes and print the digest to paste
 * back into the manifest.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';
import { FACES, VENDOR_DIR, type FontFace } from './fonts';

const repoRoot = workspaceRoot(dirOf(import.meta.url));
const acceptNew = process.argv.includes('--accept-new-digest');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchFace(face: FontFace): Promise<{ changed: boolean; digest: string }> {
  const dir = resolve(repoRoot, VENDOR_DIR, face.dir);
  mkdirSync(dir, { recursive: true });
  const binary = resolve(dir, face.file);
  const license = resolve(dir, face.licenseFile);

  if (!existsSync(license)) {
    writeFileSync(license, await download(face.licenseUrl));
    process.stdout.write(`  licence  ${face.dir}/${face.licenseFile}\n`);
  }

  if (existsSync(binary)) {
    const digest = sha256(readFileSync(binary));
    if (!face.sha256 || digest === face.sha256) {
      process.stdout.write(`  have     ${face.dir}/${face.file}  ${digest.slice(0, 16)}…\n`);
      return { changed: false, digest };
    }
    process.stdout.write(`  stale    ${face.dir}/${face.file} — re-fetching\n`);
  }

  const bytes = await download(face.url);
  const digest = sha256(bytes);
  if (face.sha256 && digest !== face.sha256 && !acceptNew) {
    throw new Error(
      `${face.family}: upstream sha256 is ${digest}, manifest pins ${face.sha256}.\n` +
        `The recorded coverage numbers were measured over the pinned bytes. Re-run with ` +
        `--accept-new-digest to take the new file, then update scripts/fonts.ts and re-run ` +
        `pnpm font:coverage before trusting any number that mentions this face.`,
    );
  }
  writeFileSync(binary, bytes);
  process.stdout.write(
    `  fetched  ${face.dir}/${face.file}  ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB  ${digest.slice(0, 16)}…\n`,
  );
  return { changed: true, digest };
}

async function main(): Promise<void> {
  process.stdout.write(`font:fetch → ${resolve(repoRoot, VENDOR_DIR)}\n`);
  const digests: string[] = [];
  for (const face of FACES) {
    const { digest } = await fetchFace(face);
    if (digest !== face.sha256) digests.push(`  ${face.family}: '${digest}'`);
  }
  if (digests.length > 0) {
    process.stdout.write(
      `\nDigests differing from scripts/fonts.ts — paste them into FACES[].sha256:\n${digests.join('\n')}\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`font:fetch failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
