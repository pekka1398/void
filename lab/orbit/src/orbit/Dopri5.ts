export type Derivative = (t: number, y: Float64Array, dy: Float64Array) => void;

// Dormand & Prince (1980) RK5(4)7M tableau.
const C2 = 1 / 5, C3 = 3 / 10, C4 = 4 / 5, C5 = 8 / 9;
const A21 = 1 / 5;
const A31 = 3 / 40, A32 = 9 / 40;
const A41 = 44 / 45, A42 = -56 / 15, A43 = 32 / 9;
const A51 = 19372 / 6561, A52 = -25360 / 2187, A53 = 64448 / 6561, A54 = -212 / 729;
const A61 = 9017 / 3168, A62 = -355 / 33, A63 = 46732 / 5247, A64 = 49 / 176, A65 = -5103 / 18656;
const B1 = 35 / 384, B3 = 500 / 1113, B4 = 125 / 192, B5 = -2187 / 6784, B6 = 11 / 84;
// 5th minus embedded 4th order weights.
const E1 = 71 / 57600, E3 = -71 / 16695, E4 = 71 / 1920, E5 = -17253 / 339200, E6 = 22 / 525, E7 = -1 / 40;

/** One explicit step with first-same-as-last reuse. Error control is the caller's policy. */
export class Dopri5 {
  readonly dimension: number;
  readonly error: Float64Array;
  private readonly k2: Float64Array;
  private readonly k3: Float64Array;
  private readonly k4: Float64Array;
  private readonly k5: Float64Array;
  private readonly k6: Float64Array;
  private readonly tmp: Float64Array;

  constructor(dimension: number) {
    this.dimension = dimension;
    this.error = new Float64Array(dimension);
    this.k2 = new Float64Array(dimension);
    this.k3 = new Float64Array(dimension);
    this.k4 = new Float64Array(dimension);
    this.k5 = new Float64Array(dimension);
    this.k6 = new Float64Array(dimension);
    this.tmp = new Float64Array(dimension);
  }

  /**
   * k1 must hold f(t, y). Writes the 5th-order solution to yOut, f(t + h, yOut)
   * to k7Out, and the local error estimate to this.error.
   */
  step(f: Derivative, t: number, y: Float64Array, k1: Float64Array, h: number, yOut: Float64Array, k7Out: Float64Array): void {
    const n = this.dimension;
    const { k2, k3, k4, k5, k6, tmp } = this;
    for (let i = 0; i < n; i += 1) tmp[i] = y[i]! + h * A21 * k1[i]!;
    f(t + C2 * h, tmp, k2);
    for (let i = 0; i < n; i += 1) tmp[i] = y[i]! + h * (A31 * k1[i]! + A32 * k2[i]!);
    f(t + C3 * h, tmp, k3);
    for (let i = 0; i < n; i += 1) tmp[i] = y[i]! + h * (A41 * k1[i]! + A42 * k2[i]! + A43 * k3[i]!);
    f(t + C4 * h, tmp, k4);
    for (let i = 0; i < n; i += 1) tmp[i] = y[i]! + h * (A51 * k1[i]! + A52 * k2[i]! + A53 * k3[i]! + A54 * k4[i]!);
    f(t + C5 * h, tmp, k5);
    for (let i = 0; i < n; i += 1) {
      tmp[i] = y[i]! + h * (A61 * k1[i]! + A62 * k2[i]! + A63 * k3[i]! + A64 * k4[i]! + A65 * k5[i]!);
    }
    f(t + h, tmp, k6);
    for (let i = 0; i < n; i += 1) {
      yOut[i] = y[i]! + h * (B1 * k1[i]! + B3 * k3[i]! + B4 * k4[i]! + B5 * k5[i]! + B6 * k6[i]!);
    }
    f(t + h, yOut, k7Out);
    for (let i = 0; i < n; i += 1) {
      this.error[i] = h * (E1 * k1[i]! + E3 * k3[i]! + E4 * k4[i]! + E5 * k5[i]! + E6 * k6[i]! + E7 * k7Out[i]!);
    }
  }
}
