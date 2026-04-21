import { FlightyError } from "./errors.js";

type WireValue = bigint | Uint8Array;

export interface WireField {
  readonly tag: number;
  readonly wire: number;
  readonly value: WireValue;
}

const utf8 = new TextDecoder("utf-8");

function readVarint(buf: Uint8Array, pos: number): { value: bigint; pos: number } {
  let result = 0n;
  let shift = 0n;
  while (true) {
    const byte = buf[pos++];
    if (byte === undefined) throw new FlightyError("unexpected end of varint");
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, pos };
    shift += 7n;
    if (shift > 70n) throw new FlightyError("varint too long");
  }
}

export function* readFields(buf: Uint8Array): Generator<WireField> {
  let pos = 0;
  while (pos < buf.length) {
    const { value: key, pos: afterKey } = readVarint(buf, pos);
    pos = afterKey;
    const k = Number(key);
    const tag = k >>> 3;
    const wire = k & 7;
    if (wire === 0) {
      const { value, pos: p } = readVarint(buf, pos);
      pos = p;
      yield { tag, wire, value };
    } else if (wire === 2) {
      const { value: len, pos: p } = readVarint(buf, pos);
      pos = p;
      const n = Number(len);
      if (n < 0 || n > buf.length - pos) {
        throw new FlightyError(
          `protobuf length-delimited field tag=${tag} extends past buffer (need ${n}, have ${buf.length - pos})`,
        );
      }
      yield { tag, wire, value: buf.subarray(pos, pos + n) };
      pos += n;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) {
        throw new FlightyError(`protobuf fixed64 field tag=${tag} extends past buffer`);
      }
      yield { tag, wire, value: buf.subarray(pos, pos + 8) };
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) {
        throw new FlightyError(`protobuf fixed32 field tag=${tag} extends past buffer`);
      }
      yield { tag, wire, value: buf.subarray(pos, pos + 4) };
      pos += 4;
    } else {
      throw new FlightyError(`unsupported protobuf wire type ${wire}`);
    }
  }
}

/**
 * Typed, lazy view over a length-delimited protobuf message.
 *
 * The field index is built once on construction. Accessors return `null` when
 * the requested tag is absent or the wire value does not match the requested
 * shape, so parsers can stay declarative.
 */
export class Message {
  readonly #fields: Map<number, WireValue[]>;

  constructor(buf: Uint8Array) {
    this.#fields = new Map();
    for (const f of readFields(buf)) {
      const existing = this.#fields.get(f.tag);
      if (existing) existing.push(f.value);
      else this.#fields.set(f.tag, [f.value]);
    }
  }

  has(tag: number): boolean {
    return this.#fields.has(tag);
  }

  bytes(tag: number): Uint8Array | undefined {
    const v = this.#fields.get(tag)?.[0];
    return v instanceof Uint8Array ? v : undefined;
  }

  str(tag: number): string | null {
    const v = this.bytes(tag);
    return v ? utf8.decode(v) : null;
  }

  int(tag: number): number | null {
    const v = this.#fields.get(tag)?.[0];
    if (typeof v !== "bigint") return null;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }

  bool(tag: number): boolean | null {
    const v = this.#fields.get(tag)?.[0];
    if (typeof v !== "bigint") return null;
    return v === 1n;
  }

  double(tag: number): number | null {
    const v = this.bytes(tag);
    if (!v || v.length < 8) return null;
    return new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true);
  }

  sub(tag: number): Message | undefined {
    const v = this.bytes(tag);
    return v ? new Message(v) : undefined;
  }

  subs(tag: number): Message[] {
    const values = this.#fields.get(tag);
    if (!values) return [];
    const out: Message[] = [];
    for (const v of values) if (v instanceof Uint8Array) out.push(new Message(v));
    return out;
  }
}
