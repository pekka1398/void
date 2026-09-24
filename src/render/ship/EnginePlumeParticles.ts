export const ENGINE_PLUME_PARTICLES_PER_CELL = 5;

const REFERENCE_NOZZLE_RADIUS = 0.267;
const GOLDEN_ANGLE = 2.399_963_229_728_653;

export interface EnginePlumeParticleInput {
  readonly particleIndex: number;
  readonly elapsedSeconds: number;
  readonly visualThrust: number;
  readonly plumeLength: number;
  readonly nozzleRadius: number;
  readonly engineIndex?: number;
  readonly shockCellIndex?: number;
}

export interface EnginePlumeParticle {
  readonly ageSeconds: number;
  readonly ageFraction: number;
  readonly lifetimeSeconds: number;
  /** Actual nozzle/shock-local coordinates; positive Z is aft of the AURORA. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly heat: number;
  readonly alpha: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function fractional(value: number): number {
  return value - Math.floor(value);
}

/**
 * Analytic real-nozzle emission: five actual particle ages repeat smoothly per
 * cell while genuine local 1× time, nozzle radius, thrust, and plume determine
 * their rearward velocity, swirl, cooling, and bounded blue-fire radiance.
 *
 * The caller renders these samples inside its existing physical shock-cell
 * geometry; this simulation never allocates a timer, emitter, draw, or light.
 */
export function sampleEnginePlumeParticle(
  input: EnginePlumeParticleInput,
): EnginePlumeParticle {
  const index = Math.max(0, Math.trunc(finite(input.particleIndex, 0)));
  const elapsed = Math.max(0, finite(input.elapsedSeconds, 0));
  const thrust = clamp(finite(input.visualThrust, 0), 0, 1);
  const plumeLength = clamp(finite(input.plumeLength, 1), 0.12, 7);
  const nozzleRadius = clamp(
    finite(input.nozzleRadius, REFERENCE_NOZZLE_RADIUS),
    0.04,
    0.72,
  );
  const nozzleScale = clamp(nozzleRadius / REFERENCE_NOZZLE_RADIUS, 0.24, 2.2);
  const engine = Math.max(0, Math.trunc(finite(input.engineIndex ?? 0, 0)));
  const cell = Math.max(0, Math.trunc(finite(input.shockCellIndex ?? 0, 0)));

  const lifetimeSeconds = 0.34 + thrust * 0.28 + Math.min(plumeLength, 5) * 0.031;
  const phase = fractional(index / ENGINE_PLUME_PARTICLES_PER_CELL +
    engine * 0.137 + cell * 0.071);
  const ageFraction = fractional(elapsed / lifetimeSeconds + phase);
  const ageSeconds = ageFraction * lifetimeSeconds;

  const radialSpread = nozzleScale *
    (0.2 + ageFraction * 0.54) *
    (0.62 + thrust * 0.34);
  const rotation = index * GOLDEN_ANGLE +
    elapsed * (2.3 + thrust * 4.8) +
    engine * 1.91 + cell * 0.43;
  const x = Math.cos(rotation) * radialSpread;
  const y = Math.sin(rotation) * radialSpread * 0.76;
  const z = 0.21 + ageFraction *
    (1.2 + thrust * 2.15 + Math.min(plumeLength, 5) * 0.16);

  const remaining = 1 - ageFraction;
  const heat = clamp(
    Math.pow(remaining, 0.82) * (0.58 + thrust * 0.42),
    0,
    1,
  );
  const radius = clamp(
    (0.19 + thrust * 0.16) *
      (0.18 + remaining * 0.82) *
      (0.78 + nozzleScale * 0.22),
    0.028,
    0.53,
  );
  const red = 0.026 + heat * heat * 0.76;
  const green = 0.2 + heat * 0.85;
  const blue = 0.44 + heat * 0.66 + remaining * 0.13;
  const alpha = clamp(
    (0.26 + thrust * 0.65) * Math.pow(remaining, 0.72),
    0.018,
    0.92,
  );

  return {
    ageSeconds,
    ageFraction,
    lifetimeSeconds,
    x,
    y,
    z,
    radius,
    red,
    green,
    blue,
    heat,
    alpha,
  };
}
