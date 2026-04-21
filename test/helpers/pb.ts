/**
 * Minimal protobuf encoder used only by tests. Supports enough of the
 * wire format to craft Flighty sync fixtures: varints (wire type 0),
 * length-delimited (wire type 2). No floats, no fixed32/64.
 */

const utf8 = new TextEncoder();

type WireType = 0 | 2;

export type FieldValue =
  | { kind: "varint"; value: number | bigint }
  | { kind: "bool"; value: boolean }
  | { kind: "str"; value: string }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "sub"; value: Uint8Array };

export interface Field {
  readonly tag: number;
  readonly value: FieldValue;
}

function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative varints not supported");
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

function encodeKey(tag: number, wire: WireType): Uint8Array {
  return encodeVarint(BigInt((tag << 3) | wire));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
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

export function encodeFields(fields: readonly Field[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    switch (f.value.kind) {
      case "varint": {
        parts.push(encodeKey(f.tag, 0));
        parts.push(encodeVarint(BigInt(f.value.value)));
        break;
      }
      case "bool": {
        parts.push(encodeKey(f.tag, 0));
        parts.push(encodeVarint(f.value.value ? 1n : 0n));
        break;
      }
      case "str": {
        parts.push(encodeKey(f.tag, 2));
        const bytes = utf8.encode(f.value.value);
        parts.push(encodeVarint(BigInt(bytes.length)));
        parts.push(bytes);
        break;
      }
      case "bytes":
      case "sub": {
        parts.push(encodeKey(f.tag, 2));
        parts.push(encodeVarint(BigInt(f.value.value.length)));
        parts.push(f.value.value);
        break;
      }
    }
  }
  return concat(parts);
}

export const varint = (value: number | bigint): FieldValue => ({ kind: "varint", value });
export const bool = (value: boolean): FieldValue => ({ kind: "bool", value });
export const str = (value: string): FieldValue => ({ kind: "str", value });
export const sub = (value: Uint8Array): FieldValue => ({ kind: "sub", value });

export const field = (tag: number, value: FieldValue): Field => ({ tag, value });

/** Wrap an already-encoded message as a sub-message payload. */
export function subMessage(fields: readonly Field[]): Uint8Array {
  return encodeFields(fields);
}
