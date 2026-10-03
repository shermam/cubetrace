// CRC-32 (IEEE 802.3, the one of zip and PNG), table-driven, as the rolling checksum of a file
// transfer (docs/RTC.md): the sender updates it chunk by chunk as it sends, the receiver as it
// writes, and the two values are compared at `file-done`. It catches a corrupted or misplaced chunk;
// it is no defence against a forger, which the data channel's own encryption (DTLS) is.

/** The table of the 256 one-byte remainders, built once. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * The CRC-32 of `bytes`, continued from `previous`, the CRC-32 of the bytes before them (0 for the
 * first): `crc32(b, crc32(a))` is `crc32(a ++ b)`. An unsigned 32-bit integer.
 */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A CRC-32 updated as the bytes come. */
export class Crc32 {
  #value = 0;

  /** Adds `bytes` to the checksum. */
  update(bytes: Uint8Array): this {
    this.#value = crc32(bytes, this.#value);
    return this;
  }

  /** The CRC-32 of every byte added so far; 0 before any. */
  get value(): number {
    return this.#value;
  }

  /** Starts again from no bytes. */
  reset(): void {
    this.#value = 0;
  }
}
