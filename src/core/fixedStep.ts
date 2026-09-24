export interface FixedStepResult {
  steps: number;
  interpolation: number;
  simulationTimeSeconds: number;
}

/** Bounded fixed-step clock prevents tab-resume catch-up spirals. */
export class FixedStepClock {
  readonly stepSeconds: number;
  readonly maximumStepsPerFrame: number;
  private accumulatorSeconds = 0;
  simulationTimeSeconds = 0;

  constructor(stepSeconds = 1 / 60, maximumStepsPerFrame = 8) {
    this.stepSeconds = stepSeconds;
    this.maximumStepsPerFrame = maximumStepsPerFrame;
  }

  advance(deltaSeconds: number, step: (deltaSeconds: number, timeSeconds: number) => void): FixedStepResult {
    this.accumulatorSeconds += Math.min(Math.max(deltaSeconds, 0), this.stepSeconds * this.maximumStepsPerFrame);
    let steps = 0;
    while (this.accumulatorSeconds >= this.stepSeconds && steps < this.maximumStepsPerFrame) {
      this.simulationTimeSeconds += this.stepSeconds;
      step(this.stepSeconds, this.simulationTimeSeconds);
      this.accumulatorSeconds -= this.stepSeconds;
      steps += 1;
    }
    return {
      steps,
      interpolation: this.accumulatorSeconds / this.stepSeconds,
      simulationTimeSeconds: this.simulationTimeSeconds,
    };
  }

  reset(timeSeconds = 0): void {
    this.accumulatorSeconds = 0;
    this.simulationTimeSeconds = timeSeconds;
  }
}
