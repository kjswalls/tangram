/**
 * SHA-1, in about forty lines, because the ask cache is keyed on one (§3.4) and
 * `crypto.subtle` is async and absent from parts of the test environment.
 *
 * Not a security primitive here — it is a cache key over content the app itself
 * produced, and the plan names sha1.
 */

function utf8(value: string): number[] {
  const out: number[] = [];
  for (const byte of new TextEncoder().encode(value)) out.push(byte);
  return out;
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export function sha1Hex(input: string): string {
  const bytes = utf8(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length; the high word is 0 for anything we hash here.
  for (let i = 0; i < 4; i += 1) bytes.push(0);
  bytes.push((bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  /**
   * `Uint32Array`, not `number[]`, and `byteAt` rather than `bytes[i]`.
   *
   * Both are for `noUncheckedIndexedAccess`, which `apps/server` sets and which
   * reaches this file through `packages/ai/cache-key.ts` (`backend.md` B2).
   * Neither changes a bit of the digest: the padding above guarantees whole
   * 64-byte chunks, so no read here is ever out of range, and a `Uint32Array`
   * holds exactly the unsigned 32-bit words the `>>> 0` was producing anyway.
   * `tests/unit/dev/sha1.test.ts` pins the digests either way.
   */
  const w = new Uint32Array(80);
  const byteAt = (index: number): number => bytes[index] ?? 0;
  const wordAt = (index: number): number => w[index] ?? 0;

  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = chunk + i * 4;
      w[i] =
        ((byteAt(at) << 24) | (byteAt(at + 1) << 16) | (byteAt(at + 2) << 8) | byteAt(at + 3)) >>> 0;
    }
    for (let i = 16; i < 80; i += 1)
      w[i] = rotl(wordAt(i - 3) ^ wordAt(i - 8) ^ wordAt(i - 14) ^ wordAt(i - 16), 1);

    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i += 1) {
      const [f, k] =
        i < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : i < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : i < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const temp = (rotl(a, 5) + f + e + k + wordAt(i)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map((word) => word.toString(16).padStart(8, '0')).join('');
}
