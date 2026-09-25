import type { Vec3 } from './Vec3';

/** Barycentric vessel samples (t, x, v) at integrator step points, strictly increasing in time. */
export class Trajectory {
  private times = new Float64Array(256);
  private states = new Float64Array(256 * 6);
  private start = 0;
  private end = 0;

  get count(): number {
    return this.end - this.start;
  }

  get firstTime(): number {
    this.requireSamples();
    return this.times[this.start]!;
  }

  get lastTime(): number {
    this.requireSamples();
    return this.times[this.end - 1]!;
  }

  clear(): void {
    this.start = 0;
    this.end = 0;
  }

  append(t: number, state: Float64Array): void {
    if (this.end > this.start && !(t > this.times[this.end - 1]!)) {
      throw new RangeError(`Trajectory: time ${t} does not follow ${this.times[this.end - 1]}`);
    }
    if (this.end === this.times.length) this.grow();
    this.times[this.end] = t;
    this.states.set(state.subarray(0, 6), this.end * 6);
    this.end += 1;
  }

  time(i: number): number {
    return this.times[this.index(i)]!;
  }

  position(i: number): Vec3 {
    const o = this.index(i) * 6;
    return { x: this.states[o]!, y: this.states[o + 1]!, z: this.states[o + 2]! };
  }

  velocity(i: number): Vec3 {
    const o = this.index(i) * 6;
    return { x: this.states[o + 3]!, y: this.states[o + 4]!, z: this.states[o + 5]! };
  }

  /** Drop samples older than t, keeping the one sample that brackets t from below. */
  trimBefore(t: number): void {
    while (this.end - this.start > 1 && this.times[this.start + 1]! <= t) this.start += 1;
  }

  /** Cubic Hermite interpolation of position and velocity inside the covered interval. */
  sample(t: number): { position: Vec3; velocity: Vec3 } {
    this.requireSamples();
    if (!(t >= this.firstTime && t <= this.lastTime)) {
      throw new RangeError(`Trajectory.sample: t=${t} outside [${this.firstTime}, ${this.lastTime}]`);
    }
    let lo = this.start;
    let hi = this.end - 1;
    if (lo === hi) return { position: this.position(0), velocity: this.velocity(0) };
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid]! <= t) lo = mid;
      else hi = mid;
    }
    const t0 = this.times[lo]!;
    const h = this.times[hi]! - t0;
    const s = (t - t0) / h;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const g00 = (6 * s2 - 6 * s) / h, g10 = 3 * s2 - 4 * s + 1, g01 = (-6 * s2 + 6 * s) / h, g11 = 3 * s2 - 2 * s;
    const a = lo * 6, b = hi * 6;
    const st = this.states;
    const p = (c: number) => h00 * st[a + c]! + h10 * h * st[a + 3 + c]! + h01 * st[b + c]! + h11 * h * st[b + 3 + c]!;
    const v = (c: number) => g00 * st[a + c]! + g10 * st[a + 3 + c]! + g01 * st[b + c]! + g11 * st[b + 3 + c]!;
    return { position: { x: p(0), y: p(1), z: p(2) }, velocity: { x: v(0), y: v(1), z: v(2) } };
  }

  private index(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) throw new RangeError(`Trajectory: index ${i} of ${this.count}`);
    return this.start + i;
  }

  private requireSamples(): void {
    if (this.count === 0) throw new RangeError('Trajectory: empty');
  }

  private grow(): void {
    const live = this.end - this.start;
    const capacity = Math.max(256, live * 2);
    const times = new Float64Array(capacity);
    const states = new Float64Array(capacity * 6);
    times.set(this.times.subarray(this.start, this.end));
    states.set(this.states.subarray(this.start * 6, this.end * 6));
    this.times = times;
    this.states = states;
    this.start = 0;
    this.end = live;
  }
}
