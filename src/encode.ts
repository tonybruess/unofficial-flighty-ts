/**
 * Minimal protobuf encoder — just enough to build Flighty request
 * bodies (varints and length-delimited fields). Kept separate from the
 * decoder in `wire.ts` so the read path stays allocation-free.
 */

const utf8 = new TextEncoder();

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`varint must be a non-negative integer, got ${value}`);
  }
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 0x80);
  }
  bytes.push(v);
  return Uint8Array.from(bytes);
}

/** Encode a length-delimited (wire type 2) field: string or sub-message. */
export function lengthDelimited(tag: number, value: string | Uint8Array): Uint8Array {
  const payload = typeof value === "string" ? utf8.encode(value) : value;
  return concat([encodeVarint((tag << 3) | 2), encodeVarint(payload.length), payload]);
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
