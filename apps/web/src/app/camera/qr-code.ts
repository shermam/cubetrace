// A QR code encoder for the pairing URL of a remote camera (docs/PLAN.md T4.1, docs/RTC.md §5): byte
// mode, error correction level M, versions 1 to 10 (up to 213 bytes; the URL takes about 100), the
// mask chosen by the standard's penalty score, as ISO/IEC 18004 lays it out. Written here rather
// than taken from a package: the app adds no dependency for 250 lines (CLAUDE.md), and the tests
// decode what it draws with a reader. Pure, so that it is tested in jsdom; `qrSvgPath` draws the
// modules as one SVG path.

/** The error correction levels, as the format information codes them. */
export type QrLevel = 'L' | 'M';

/** A QR code's modules: `modules[row][col]` is dark when true. */
export interface QrCode {
  readonly version: number;
  /** The side, in modules: 17 + 4 × version. */
  readonly size: number;
  readonly level: QrLevel;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

/** The most versions this encoder makes: version 10 is 57 modules a side. */
const MAX_VERSION = 10;

/** The codewords of a version, in all: data and error correction together. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * The error correction blocks of each version at each level: the correction codewords per block,
 * and the blocks with their data codewords (a version may have two block sizes, the larger ones
 * last).
 */
const BLOCKS: Readonly<
  Record<QrLevel, readonly (readonly [number, readonly (readonly [number, number])[]])[]>
> = {
  M: [
    [0, []],
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [
      22,
      [
        [2, 38],
        [2, 39],
      ],
    ],
    [
      22,
      [
        [3, 36],
        [2, 37],
      ],
    ],
    [
      26,
      [
        [4, 43],
        [1, 44],
      ],
    ],
  ],
  L: [
    [0, []],
    [7, [[1, 19]]],
    [10, [[1, 34]]],
    [15, [[1, 55]]],
    [20, [[1, 80]]],
    [26, [[1, 108]]],
    [18, [[2, 68]]],
    [20, [[2, 78]]],
    [24, [[2, 97]]],
    [30, [[2, 116]]],
    [
      18,
      [
        [2, 68],
        [2, 69],
      ],
    ],
  ],
};

/** The bits of the format information that name a level. */
const LEVEL_BITS: Readonly<Record<QrLevel, number>> = { L: 1, M: 0 };

/** The penalties of the mask score: runs, blocks, finder-like patterns, the dark share. */
const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

/** The data codewords a version holds at a level. */
function dataCodewords(version: number, level: QrLevel): number {
  const [ec, blocks] = BLOCKS[level][version];
  return blocks.reduce((sum, [count, data]) => sum + count * data, 0) + 0 * ec;
}

/** The smallest version whose data codewords hold `bytes` in byte mode, or null when none does. */
export function qrVersionFor(bytes: number, level: QrLevel = 'M'): number | null {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const header = 4 + (version <= 9 ? 8 : 16);
    if (header + bytes * 8 <= dataCodewords(version, level) * 8) {
      return version;
    }
  }
  return null;
}

/**
 * The QR code of `text`, encoded as UTF-8 bytes at level `level`, in the smallest version that holds
 * it, with the mask of least penalty. Throws when the text does not fit version 10.
 */
export function qrCode(text: string, level: QrLevel = 'M'): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length, level);
  if (version === null) {
    throw new Error(
      `The text of ${String(bytes.length)} bytes does not fit a QR code of version 10.`,
    );
  }
  const codewords = interleave(dataBits(bytes, version, level), version, level);
  const size = 17 + 4 * version;
  const layout = new Layout(size, version);
  layout.drawFunctionPatterns();
  layout.drawCodewords(codewords, remainderBits(version));
  let best = 0;
  let least = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    layout.applyMask(mask);
    layout.drawFormat(level, mask);
    const penalty = layout.penalty();
    if (penalty < least) {
      least = penalty;
      best = mask;
    }
    layout.applyMask(mask); // The mask is its own inverse.
  }
  layout.applyMask(best);
  layout.drawFormat(level, best);
  return { version, size, level, mask: best, modules: layout.modules.map((row) => [...row]) };
}

/**
 * The dark modules of `code` as the `d` attribute of one SVG path, each module a unit square at its
 * column and row, with `quiet` modules of margin around the code (4, as the standard asks): a
 * `viewBox` of `0 0 (size + 2 × quiet) (size + 2 × quiet)` shows it whole.
 */
export function qrSvgPath(code: QrCode, quiet = 4): string {
  const parts: string[] = [];
  for (const [row, modules] of code.modules.entries()) {
    for (const [col, dark] of modules.entries()) {
      if (dark) {
        parts.push(`M${String(col + quiet)} ${String(row + quiet)}h1v1h-1z`);
      }
    }
  }
  return parts.join('');
}

// ---- The data: mode, count, bytes, terminator, padding ----

/** The data codewords of `bytes` in byte mode, padded to the version's capacity. */
function dataBits(bytes: Uint8Array, version: number, level: QrLevel): Uint8Array {
  const capacity = dataCodewords(version, level) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) {
    push(byte, 8);
  }
  // The terminator, as far as there is room, then up to the byte, then the pad codewords.
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    push(pad, 8);
  }
  const out = new Uint8Array(capacity / 8);
  for (const [i, bit] of bits.entries()) {
    out[i >>> 3] |= bit << (7 - (i & 7));
  }
  return out;
}

/** The remainder bits after the codewords, which the version's module count leaves over. */
function remainderBits(version: number): number {
  return version >= 2 && version <= 6 ? 7 : 0;
}

// ---- Reed–Solomon over GF(256) with the polynomial 0x11D ----

/** The product of two elements of the field. */
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The generator polynomial of `degree` correction codewords, without its leading 1. */
function divisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = multiply(root, 0x02);
  }
  return result;
}

/** The correction codewords of `data`: the remainder of its division by the generator. */
function remainder(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const result = new Uint8Array(generator.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < generator.length; i++) {
      result[i] ^= multiply(generator[i], factor);
    }
  }
  return result;
}

/** The data split into the version's blocks, each with its correction codewords, interleaved. */
function interleave(data: Uint8Array, version: number, level: QrLevel): Uint8Array {
  const [ecLength, shape] = BLOCKS[level][version];
  const generator = divisor(ecLength);
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let offset = 0;
  for (const [count, length] of shape) {
    for (let k = 0; k < count; k++) {
      const block = data.subarray(offset, offset + length);
      blocks.push({ data: block, ec: remainder(block, generator) });
      offset += length;
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) {
      if (i < block.data.length) {
        out.push(block.data[i]);
      }
    }
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of blocks) {
      out.push(block.ec[i]);
    }
  }
  if (out.length !== TOTAL_CODEWORDS[version]) {
    throw new Error(
      `Version ${String(version)} has ${String(out.length)} codewords, not ${String(TOTAL_CODEWORDS[version])}.`,
    );
  }
  return new Uint8Array(out);
}

// ---- The modules ----

/** The matrix of a version while it is laid out: the modules, and which of them are function patterns. */
class Layout {
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(
    readonly size: number,
    private readonly version: number,
  ) {
    this.modules = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
    this.isFunction = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  }

  /** The finder, timing and alignment patterns, the dark module, and the format and version areas (reserved). */
  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    for (const [i, row] of positions.entries()) {
      for (const [j, col] of positions.entries()) {
        if (!((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0))) {
          this.drawAlignment(col, row);
        }
      }
    }
    // The format areas are reserved now and written for each mask; the version area too.
    this.drawFormat('M', 0);
    this.drawVersion();
  }

  /** The codewords into the free modules, two columns at a time, upwards then downwards. */
  drawCodewords(codewords: Uint8Array, remainder: number): void {
    const bits = codewords.length * 8 + remainder;
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        right = 5;
      }
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const col = right - j;
          const upward = ((right + 1) & 2) === 0;
          const row = upward ? this.size - 1 - vertical : vertical;
          if (!this.isFunction[row][col] && i < bits) {
            const bit = i < codewords.length * 8 ? (codewords[i >>> 3] >>> (7 - (i & 7))) & 1 : 0;
            this.modules[row][col] = bit === 1;
            i++;
          }
        }
      }
    }
  }

  /** XORs the data modules with mask `mask`; applied again, it undoes itself. */
  applyMask(mask: number): void {
    for (let row = 0; row < this.size; row++) {
      for (let col = 0; col < this.size; col++) {
        if (!this.isFunction[row][col] && masked(mask, row, col)) {
          this.modules[row][col] = !this.modules[row][col];
        }
      }
    }
  }

  /** The format information, BCH coded, in both of its places. */
  drawFormat(level: QrLevel, mask: number): void {
    const data = (LEVEL_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) {
      this.setFunction(8, i, bit(i));
    }
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) {
      this.setFunction(14 - i, 8, bit(i));
    }
    for (let i = 0; i < 8; i++) {
      this.setFunction(this.size - 1 - i, 8, bit(i));
    }
    for (let i = 8; i < 15; i++) {
      this.setFunction(8, this.size - 15 + i, bit(i));
    }
    // The dark module, beside the format information's second copy.
    this.setFunction(8, this.size - 8, true);
  }

  /** The standard's penalty score of the modules as masked. */
  penalty(): number {
    let score = 0;
    const m = this.modules;
    const n = this.size;
    // Runs of 5 or more alike in a row or a column, and finder-like patterns.
    for (let row = 0; row < n; row++) {
      score += lineScore((i) => m[row][i], n);
      score += lineScore((i) => m[i][row], n);
    }
    // Blocks of 2 × 2 alike.
    for (let row = 0; row < n - 1; row++) {
      for (let col = 0; col < n - 1; col++) {
        const dark = m[row][col];
        if (dark === m[row][col + 1] && dark === m[row + 1][col] && dark === m[row + 1][col + 1]) {
          score += PENALTY_BLOCK;
        }
      }
    }
    // The share of dark modules, away from a half, by steps of 5%.
    let dark = 0;
    for (const row of m) {
      for (const module of row) {
        dark += module ? 1 : 0;
      }
    }
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return score + Math.max(0, k) * PENALTY_BALANCE;
  }

  private setFunction(col: number, row: number, dark: boolean): void {
    this.modules[row][col] = dark;
    this.isFunction[row][col] = true;
  }

  private drawFinder(col: number, row: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = col + dx;
        const y = row + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  private drawAlignment(col: number, row: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(col + dx, row + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** The centres of the alignment patterns along each side: 6, then evenly to size − 7. */
  private alignmentPositions(): number[] {
    if (this.version === 1) {
      return [];
    }
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2;
    const positions = [6];
    for (let position = this.size - 7; positions.length < count; position -= step) {
      positions.splice(1, 0, position);
    }
    return positions;
  }

  /** The version information, BCH coded, for versions 7 and up. */
  private drawVersion(): void {
    if (this.version < 7) {
      return;
    }
    let rem = this.version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }
}

/** Whether mask `mask` inverts the module at `row`, `col`. */
function masked(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** The penalty of one line: its runs of 5 or more, and its finder-like patterns. */
function lineScore(at: (i: number) => boolean, n: number): number {
  let score = 0;
  let run = 0;
  let last: boolean | null = null;
  const history = [0, 0, 0, 0, 0, 0, 0];
  const finderLike = (): boolean => {
    const h = history;
    const core = h[1] > 0 && h[2] === h[1] && h[3] === h[1] * 3 && h[4] === h[1] && h[5] === h[1];
    return core && (h[0] >= 4 * h[1] || h[6] >= 4 * h[1]);
  };
  const pushRun = (length: number): void => {
    history.shift();
    history.push(length);
  };
  for (let i = 0; i <= n; i++) {
    const dark = i < n ? at(i) : null;
    if (dark === last) {
      run++;
      continue;
    }
    if (last !== null) {
      if (run >= 5) {
        score += PENALTY_RUN + run - 5;
      }
      pushRun(run);
      if (last === false && finderLike()) {
        score += PENALTY_FINDER;
      }
    }
    last = dark;
    run = 1;
  }
  // The line's end counts as light space after the last run.
  pushRun(4);
  if (finderLike()) {
    score += PENALTY_FINDER;
  }
  return score;
}
