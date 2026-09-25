import type { Vec3 } from '../orbit';

/**
 * Samples of a path already transformed into the plotting frame. A frame's
 * transform depends only on the sample's own time, so past samples never
 * change and only new ones are computed each frame. The owner discards the
 * cache when the frame or sampling interval changes.
 */
export class PathCache {
  readonly intervalSeconds: number;
  private times = new Float64Array(1024);
  private coords = new Float64Array(1024 * 3);
  private start = 0;
  private end = 0;

  constructor(intervalSeconds: number) {
    if (!(intervalSeconds > 0) || !Number.isFinite(intervalSeconds)) throw new RangeError(`PathCache interval ${intervalSeconds}`);
    this.intervalSeconds = intervalSeconds;
  }

  get count(): number {
    return this.end - this.start;
  }

  /**
   * Keep samples on the grid k * interval inside [from, to). Both ends only
   * move forward for one cache; the owner starts a new cache otherwise.
   */
  update(from: number, to: number, sample: (t: number) => Vec3): void {
    while (this.start < this.end && this.times[this.start]! < from) this.start += 1;
    const dt = this.intervalSeconds;
    let next = this.end > this.start ? this.times[this.end - 1]! + dt : Math.ceil(from / dt) * dt;
    if (next < from) next = Math.ceil(from / dt) * dt;
    for (; next < to; next += dt) {
      const p = sample(next);
      if (this.end === this.times.length) this.grow();
      this.times[this.end] = next;
      this.coords[this.end * 3] = p.x;
      this.coords[this.end * 3 + 1] = p.y;
      this.coords[this.end * 3 + 2] = p.z;
      this.end += 1;
    }
  }

  /**
   * Write head, the cached samples, then tail into out (three.js Y-up axes,
   * relative to origin, scaled). Returns the number of vertices written.
   */
  writeRelative(out: Float32Array, origin: Vec3, head: Vec3 | null, tail: Vec3 | null, scaleFactor: number): number {
    let n = 0;
    if (head) writeVertex(out, n++, head.x - origin.x, head.y - origin.y, head.z - origin.z, scaleFactor);
    for (let i = this.start; i < this.end; i += 1, n += 1) {
      writeVertex(out, n, this.coords[i * 3]! - origin.x, this.coords[i * 3 + 1]! - origin.y, this.coords[i * 3 + 2]! - origin.z, scaleFactor);
    }
    if (tail) writeVertex(out, n++, tail.x - origin.x, tail.y - origin.y, tail.z - origin.z, scaleFactor);
    return n;
  }

  /**
   * Write RGB per vertex in the same order as writeRelative: the base colour
   * scaled toward black by lightness(t) in [0, 1]. Returns the vertex count.
   */
  writeColors(out: Float32Array, headTime: number | null, tailTime: number | null, rgb: readonly [number, number, number], lightness: (t: number) => number): number {
    let n = 0;
    const put = (t: number) => {
      const k = lightness(t);
      out[n * 3] = rgb[0] * k; out[n * 3 + 1] = rgb[1] * k; out[n * 3 + 2] = rgb[2] * k;
      n += 1;
    };
    if (headTime !== null) put(headTime);
    for (let i = this.start; i < this.end; i += 1) put(this.times[i]!);
    if (tailTime !== null) put(tailTime);
    return n;
  }

  private grow(): void {
    const live = this.end - this.start;
    const times = new Float64Array(Math.max(1024, live * 2));
    const coords = new Float64Array(times.length * 3);
    times.set(this.times.subarray(this.start, this.end));
    coords.set(this.coords.subarray(this.start * 3, this.end * 3));
    this.times = times;
    this.coords = coords;
    this.start = 0;
    this.end = live;
  }
}

/** Ecliptic Z-up (x, y, z) maps to three.js Y-up (x, z, -y), a proper rotation. */
export function writeVertex(out: Float32Array, index: number, x: number, y: number, z: number, scaleFactor: number): void {
  out[index * 3] = x * scaleFactor;
  out[index * 3 + 1] = z * scaleFactor;
  out[index * 3 + 2] = -y * scaleFactor;
}
