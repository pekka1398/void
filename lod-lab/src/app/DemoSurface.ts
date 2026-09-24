import type { Vec3 } from '../lod/Vec3';
import type { SurfaceSample } from '../lod/TileMeshBuilder';

/** Deterministic fixture for exploring geometry and LOD without game state. */
export const DEMO_RADIUS_METERS = 6_371_000;
export const DEMO_MAX_HEIGHT_METERS = 12_000;

export function sampleDemoSurface(direction: Vec3): SurfaceSample {
  const { x, y, z } = direction;
  const continent = Math.sin(x * 7 + Math.sin(z * 5) * 1.7)
    + Math.cos(z * 9 - y * 4) * 0.55 + Math.sin(y * 13 + x * 3) * 0.25;
  const ridge = Math.abs(Math.sin(x * 48 + z * 31) * Math.cos(y * 42 - z * 17));
  const land = Math.max(0, continent - 0.08);
  const heightMeters = land > 0 ? Math.min(DEMO_MAX_HEIGHT_METERS, land * 3200 + ridge * land * 2100) : 0;
  const color: readonly [number, number, number] = land > 0
    ? heightMeters > 5100 ? [0.64, 0.66, 0.63] : [0.14 + land * 0.08, 0.33 + land * 0.07, 0.18]
    : [0.025, 0.17 + Math.max(0, continent + 0.4) * 0.1, 0.32];
  return { heightMeters, color };
}
