export type SeedPart = string | number | bigint | boolean;

/** Stable FNV-1a string hashing; never use Math.random for persistent worlds. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mixUint32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function deriveSeed(...parts: readonly SeedPart[]): number {
  let result = 0x811c9dc5;
  for (const part of parts) {
    const encoded = `${typeof part}:${String(part)}`;
    result = mixUint32(result ^ hashString(encoded));
  }
  return result >>> 0;
}

export const hashParts = deriveSeed;

/** Mulberry32 offers reproducible uint32 output across browser engines. */
export class SeededRandom {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === "string" ? hashString(seed) : seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let result = this.state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  }

  uint32(): number {
    return Math.floor(this.next() * 4_294_967_296) >>> 0;
  }

  range(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.next();
  }

  int(minimum: number, maximumExclusive: number): number {
    if (maximumExclusive <= minimum) return minimum;
    return minimum + Math.floor(this.next() * (maximumExclusive - minimum));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    const selection = values[this.int(0, values.length)];
    if (selection === undefined) throw new RangeError("Cannot choose from an empty collection");
    return selection;
  }

  signed(): number {
    return this.next() * 2 - 1;
  }

  fork(...parts: readonly SeedPart[]): SeededRandom {
    return new SeededRandom(deriveSeed(this.state, ...parts));
  }
}
