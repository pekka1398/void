import * as THREE from 'three';
import type { CelestialLightFrame } from '../../lighting';

/** A visible optical source is always the screen projection of one actual star. */
export interface ProjectedCelestialSource {
  readonly id: string;
  readonly u: number;
  readonly v: number;
  readonly visible: boolean;
  /** Apparent physical stellar radius divided by the real viewport height. */
  readonly angularRadius: number;
  readonly color?: string;
}

const MINIMUM_EXPOSURE = 0.88;
const MAXIMUM_EXPOSURE = 1.62;
const DEFAULT_EXPOSURE = 1.34;
const BRIGHT_ADAPTATION_SECONDS = 0.38;
const DARK_ADAPTATION_SECONDS = 1.72;

/**
 * Adapt to actual local stellar irradiance without reading GPU pixels.
 *
 * The simulation's accelerated celestial epoch is deliberately irrelevant:
 * adaptation advances only by the same real delta as flight and local weather.
 */
export class ExposureController {
  private currentExposure: number;
  private targetExposure: number;

  constructor(initialExposure = DEFAULT_EXPOSURE) {
    const initial = Number.isFinite(initialExposure) ? initialExposure : DEFAULT_EXPOSURE;
    this.currentExposure = THREE.MathUtils.clamp(initial, MINIMUM_EXPOSURE, MAXIMUM_EXPOSURE);
    this.targetExposure = this.currentExposure;
  }

  get value(): number {
    return this.currentExposure;
  }

  get target(): number {
    return this.targetExposure;
  }

  update(
    frame: CelestialLightFrame,
    localRealDeltaSeconds: number,
    projectedSources: readonly ProjectedCelestialSource[] = [],
  ): number {
    const atmosphere = THREE.MathUtils.clamp(frame.atmosphereDensity, 0, 1);
    const daylight = THREE.MathUtils.clamp(frame.daylight, 0, 1);
    const twilight = THREE.MathUtils.clamp(frame.twilight, 0, 1);
    const night = THREE.MathUtils.clamp(frame.night, 0, 1);
    const irradiance = Math.log2(1 + Math.max(0, frame.totalIrradianceSolar));

    let framedStellarEnergy = 0;
    for (const projected of projectedSources.slice(0, 3)) {
      if (!projected.visible) continue;
      const source = frame.sources.find((entry) => entry.active && entry.id === projected.id);
      if (!source) continue;
      const x = projected.u * 2 - 1;
      const y = projected.v * 2 - 1;
      const centralWeight = THREE.MathUtils.clamp(1 - Math.hypot(x, y) * 0.58, 0.24, 1);
      framedStellarEnergy += Math.min(1.8, source.receivedIrradianceSolar) *
        source.visibility * centralWeight;
    }

    this.targetExposure = THREE.MathUtils.clamp(
      1.38 + night * 0.16 + twilight * 0.045 -
        daylight * 0.105 - atmosphere * daylight * 0.04 -
        Math.min(1.9, irradiance) * 0.095 -
        Math.min(1.35, framedStellarEnergy) * 0.085,
      MINIMUM_EXPOSURE,
      MAXIMUM_EXPOSURE,
    );

    if (!Number.isFinite(localRealDeltaSeconds) || localRealDeltaSeconds <= 0) {
      return this.currentExposure;
    }

    const realDelta = Math.min(localRealDeltaSeconds, 0.15);
    const responseSeconds = this.targetExposure < this.currentExposure
      ? BRIGHT_ADAPTATION_SECONDS
      : DARK_ADAPTATION_SECONDS;
    const response = 1 - Math.exp(-realDelta / responseSeconds);
    this.currentExposure = THREE.MathUtils.lerp(
      this.currentExposure,
      this.targetExposure,
      response,
    );
    return this.currentExposure;
  }
}
