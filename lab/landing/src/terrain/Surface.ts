import type { Vec3 } from '../orbitCore';

/**
 * The terrain contract, identical to lab/lod's SurfaceSampler so its terrain
 * can replace the lab's by passing a different function.
 * Input: a unit direction in body-fixed axes (z = spin axis, x = prime
 * meridian); anything else must throw. Output: height above the reference
 * radius in [0, maxHeightMeters], and a display colour (linear 0-1).
 */
export interface SurfaceSample {
  readonly heightMeters: number;
  readonly color: readonly [number, number, number];
}

/** Optional cell size band-limits geometry; point queries request full detail. */
export type SurfaceSampler = (bodyFixedDirection: Vec3, cellMeters?: number) => SurfaceSample;

/** A planet's solid surface: the sampler plus the bounds everything else relies on. */
export interface Terrain {
  readonly name: string;
  readonly radiusMeters: number;
  readonly maxHeightMeters: number;
  readonly sample: SurfaceSampler;
}

export function assertUnitDirection(d: Vec3, where: string): void {
  const length = Math.hypot(d.x, d.y, d.z);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-9) {
    throw new RangeError(`${where}: expected a unit direction, got ${JSON.stringify(d)} (length ${length})`);
  }
}
