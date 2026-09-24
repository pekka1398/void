export interface FrameTimingSnapshot {
  readonly samples: number;
  readonly cpuMedianMs: number;
  readonly cpuP95Ms: number;
  readonly cpuMaximumMs: number;
  readonly frameMedianMs: number;
  readonly frameP95Ms: number;
  readonly frameMaximumMs: number;
  readonly cpuFramesOver50Ms: number;
  readonly framesOver50Ms: number;
}

/**
 * Bounded, allocation-free recording of real active frames. CPU time includes
 * simulation and render submission, not asynchronous GPU execution. Sorting
 * happens only when diagnostics are requested, never in the animation loop.
 */
export class FrameTiming {
  private readonly cpu: Float64Array;
  private readonly frame: Float64Array;
  private cursor = 0;
  private count = 0;

  constructor(capacity = 240) {
    const size = Number.isFinite(capacity) ? Math.max(1, Math.min(3_600, Math.floor(capacity))) : 240;
    this.cpu = new Float64Array(size);
    this.frame = new Float64Array(size);
  }

  record(cpuMilliseconds: number, frameMilliseconds: number): void {
    if (!Number.isFinite(cpuMilliseconds) || cpuMilliseconds < 0 ||
        !Number.isFinite(frameMilliseconds) || frameMilliseconds <= 0) return;
    this.cpu[this.cursor] = cpuMilliseconds;
    this.frame[this.cursor] = frameMilliseconds;
    this.cursor = (this.cursor + 1) % this.cpu.length;
    this.count = Math.min(this.count + 1, this.cpu.length);
  }

  reset(): void {
    this.cursor = 0;
    this.count = 0;
  }

  get snapshot(): FrameTimingSnapshot {
    const cpu = [...this.cpu.subarray(0, this.count)].sort((a, b) => a - b);
    const frame = [...this.frame.subarray(0, this.count)].sort((a, b) => a - b);
    const percentile = (values: number[], fraction: number): number =>
      values.length ? values[Math.floor((values.length - 1) * fraction)]! : 0;
    return {
      samples: this.count,
      cpuMedianMs: percentile(cpu, 0.5),
      cpuP95Ms: percentile(cpu, 0.95),
      cpuMaximumMs: percentile(cpu, 1),
      frameMedianMs: percentile(frame, 0.5),
      frameP95Ms: percentile(frame, 0.95),
      frameMaximumMs: percentile(frame, 1),
      cpuFramesOver50Ms: cpu.filter((duration) => duration > 50).length,
      framesOver50Ms: frame.filter((duration) => duration > 50).length,
    };
  }
}
