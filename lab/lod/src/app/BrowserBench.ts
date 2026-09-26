import type { BenchFrame, BenchScenario } from './BenchScenarios';

/** One rendered frame's costs. Times are milliseconds. */
export interface BenchSample {
  /** requestAnimationFrame interval ending at this frame. */
  readonly rafMs: number;
  readonly selectMs: number;
  readonly walkMs: number;
  readonly balanceMs: number;
  readonly evictMs: number;
  /** Worker queue update (TileWorkerPool.setWanted). */
  readonly queueMs: number;
  /** TileRenderer.sync: GPU object creation, disposal and placement. */
  readonly syncMs: number;
  /** CPU time of the renderAsync call. */
  readonly renderCpuMs: number;
  /** GPU time from timer queries, resolved late and possibly summed over frames; null when unavailable. */
  readonly gpuMs: number | null;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly drawn: number;
  readonly requests: number;
  readonly collapses: number;
}

export interface BenchWorkload {
  readonly requests: number;
  readonly queued: number;
  readonly inFlight: number;
  readonly built: number;
  readonly buildMillisecondsTotal: number;
}

interface Stat { readonly p50: number; readonly p95: number; readonly max: number; readonly mean: number }

export interface BenchScenarioResult {
  readonly name: string;
  readonly frames: number;
  /** Time to finish every build at the first frame before timing starts; null if it timed out. */
  readonly startSettleMs: number | null;
  /** After the path ends: frames and time until nothing is requested, queued or building; null if it timed out. */
  readonly drainFrames: number | null;
  readonly drainMs: number | null;
  /** Tiles built by the workers while the path ran, and their mean worker build time. */
  readonly built: number;
  readonly meanBuildMs: number | null;
  readonly stats: Readonly<Record<Exclude<keyof BenchSample, 'gpuMs'>, Stat>> & { readonly gpuMs: Stat | null };
}

type Phase =
  | { kind: 'settle'; since: number }
  | { kind: 'run'; frame: number; built: number; buildMs: number; samples: BenchSample[]; startSettleMs: number | null }
  | { kind: 'drain'; since: number; frames: number; result: Omit<BenchScenarioResult, 'drainFrames' | 'drainMs'> };

const SETTLE_TIMEOUT_MS = 30_000;

/**
 * Drives the lab through scripted scenarios, one step per rendered frame:
 * settle at the first step (untimed), run the path recording every frame,
 * then hold the last step until the workers drain.
 */
export class BrowserBench {
  private index = 0;
  private phase: Phase;
  private readonly results: BenchScenarioResult[] = [];

  constructor(private readonly scenarios: readonly BenchScenario[], private readonly onDone: (results: readonly BenchScenarioResult[]) => void) {
    if (scenarios.length === 0) throw new Error('BrowserBench.ts: no scenarios');
    this.phase = { kind: 'settle', since: performance.now() };
  }

  get finished(): boolean { return this.index >= this.scenarios.length; }

  get status(): string {
    if (this.finished) return `bench done: ${this.results.length} scenarios`;
    const scenario = this.scenarios[this.index]!;
    const where = this.phase.kind === 'run' ? `frame ${this.phase.frame}/${scenario.frames}` : this.phase.kind;
    return `bench ${this.index + 1}/${this.scenarios.length} ${scenario.name}: ${where}`;
  }

  /** The step to show this frame, or undefined once every scenario is done. */
  frame(): BenchFrame | undefined {
    if (this.finished) return undefined;
    const scenario = this.scenarios[this.index]!;
    if (this.phase.kind === 'settle') return scenario.at(0);
    if (this.phase.kind === 'run') return scenario.at(this.phase.frame);
    return scenario.at(scenario.frames);
  }

  /** Report the frame just rendered from `frame()`. */
  record(sample: BenchSample, workload: BenchWorkload, now: number): void {
    if (this.finished) throw new Error('BrowserBench.ts record: benchmark already finished');
    const scenario = this.scenarios[this.index]!;
    const quiet = workload.requests === 0 && workload.queued === 0 && workload.inFlight === 0;
    const phase = this.phase;
    if (phase.kind === 'settle') {
      const timedOut = now - phase.since > SETTLE_TIMEOUT_MS;
      if (quiet || timedOut) {
        this.phase = { kind: 'run', frame: 1, built: workload.built, buildMs: workload.buildMillisecondsTotal, samples: [],
          startSettleMs: timedOut ? null : now - phase.since };
      }
      return;
    }
    if (phase.kind === 'run') {
      phase.samples.push(sample);
      phase.frame++;
      if (phase.frame > scenario.frames) {
        const built = workload.built - phase.built;
        this.phase = { kind: 'drain', since: now, frames: 0, result: {
          name: scenario.name, frames: scenario.frames, startSettleMs: phase.startSettleMs, built,
          meanBuildMs: built > 0 ? (workload.buildMillisecondsTotal - phase.buildMs) / built : null,
          stats: summarize(phase.samples),
        } };
      }
      return;
    }
    const timedOut = now - phase.since > SETTLE_TIMEOUT_MS;
    if (quiet || timedOut) {
      this.results.push({ ...phase.result, drainFrames: timedOut ? null : phase.frames, drainMs: timedOut ? null : now - phase.since });
      this.index++;
      this.phase = { kind: 'settle', since: now };
      if (this.finished) this.onDone(this.results);
      return;
    }
    phase.frames++;
  }
}

function stat(values: readonly number[]): Stat {
  if (values.length === 0) throw new Error('BrowserBench.ts stat: no samples');
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]!, mean: values.reduce((a, b) => a + b, 0) / values.length };
}

function summarize(samples: readonly BenchSample[]): BenchScenarioResult['stats'] {
  const column = (key: Exclude<keyof BenchSample, 'gpuMs'>) => stat(samples.map((sample) => sample[key]));
  const gpu = samples.map((sample) => sample.gpuMs).filter((value): value is number => value !== null);
  return {
    rafMs: column('rafMs'), selectMs: column('selectMs'), walkMs: column('walkMs'), balanceMs: column('balanceMs'),
    evictMs: column('evictMs'), queueMs: column('queueMs'), syncMs: column('syncMs'), renderCpuMs: column('renderCpuMs'),
    drawCalls: column('drawCalls'), triangles: column('triangles'), drawn: column('drawn'), requests: column('requests'),
    collapses: column('collapses'),
    gpuMs: gpu.length > 0 ? stat(gpu) : null,
  };
}
