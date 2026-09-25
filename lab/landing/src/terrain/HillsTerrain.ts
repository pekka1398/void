import type { Vec3 } from '../orbitCore';
import { assertUnitDirection, type SurfaceSample, type Terrain } from './Surface';

/**
 * Placeholder terrain: fractal gradient noise on the unit sphere, shaped into
 * rolling hills. Meant to be replaced by lab/lod's terrain, which follows the
 * same contract.
 */
export interface HillsOptions {
  name: string;
  radiusMeters: number;
  maxHeightMeters: number;
  /** Wavelength of the largest hills along the surface, metres. */
  wavelengthMeters: number;
  octaves: number;
}

const GRADIENTS: readonly (readonly [number, number, number])[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** 3D gradient noise in about [-1, 1]. */
function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const corner = (dx: number, dy: number, dz: number): number => {
    const g = GRADIENTS[hash(ix + dx, iy + dy, iz + dz) % GRADIENTS.length]!;
    return g[0] * (fx - dx) + g[1] * (fy - dy) + g[2] * (fz - dz);
  };
  const wx = fade(fx), wy = fade(fy), wz = fade(fz);
  return lerp(
    lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), wx), lerp(corner(0, 1, 0), corner(1, 1, 0), wx), wy),
    lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), wx), lerp(corner(0, 1, 1), corner(1, 1, 1), wx), wy),
    wz,
  );
}

export function hillsTerrain(options: HillsOptions): Terrain {
  const { radiusMeters, maxHeightMeters, wavelengthMeters, octaves } = options;
  if (!(radiusMeters > 0) || !(maxHeightMeters > 0) || !(wavelengthMeters > 0) || !(octaves >= 1)) {
    throw new RangeError(`hillsTerrain: ${JSON.stringify(options)}`);
  }
  // Noise has about one feature per unit, so this many units span the radius.
  const frequency = radiusMeters / wavelengthMeters;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) norm += 0.5 ** o;
  const sample = (d: Vec3): SurfaceSample => {
    assertUnitDirection(d, `${options.name} terrain`);
    let sum = 0;
    for (let o = 0, f = frequency, a = 1; o < octaves; o += 1, f *= 2, a *= 0.5) {
      sum += a * noise(d.x * f + 17.3 * o, d.y * f, d.z * f);
    }
    // Gradient noise stays within about +-1; clamp so the contract bound holds exactly.
    const unit = Math.min(1, Math.max(0, 0.5 + 0.75 * (sum / norm)));
    const heightMeters = maxHeightMeters * unit * unit;
    const color: readonly [number, number, number] = [0.18 + 0.35 * unit, 0.32 + 0.1 * unit, 0.14 + 0.2 * unit];
    return { heightMeters, color };
  };
  return { name: options.name, radiusMeters, maxHeightMeters, sample };
}
