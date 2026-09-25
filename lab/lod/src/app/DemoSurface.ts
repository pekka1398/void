import type { Vec3 } from '../lod/Vec3';
import type { SurfaceSample } from '../lod/TileMeshBuilder';
import { SEAM_TEST_PLANET, type PlanetPreset } from './PlanetPresets';

/** Deliberately exaggerated terrain for inspecting LOD seams. */
export const DEMO_RADIUS_METERS = SEAM_TEST_PLANET.radiusMeters;
export const DEMO_MAX_HEIGHT_METERS = SEAM_TEST_PLANET.maxSurfaceHeightMeters;

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
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Continuous 3D gradient noise; the same direction gives the same height on every cube face. */
function perlin(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const wx = fade(fx), wy = fade(fy), wz = fade(fz);
  const corner = (dx: number, dy: number, dz: number): number => {
    const gradient = GRADIENTS[hash(ix + dx, iy + dy, iz + dz) % GRADIENTS.length]!;
    return (gradient[0] * (fx - dx) + gradient[1] * (fy - dy) + gradient[2] * (fz - dz)) * 0.7071067811865476;
  };
  const bottom = lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), wx),
    lerp(corner(0, 1, 0), corner(1, 1, 0), wx), wy);
  const top = lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), wx),
    lerp(corner(0, 1, 1), corner(1, 1, 1), wx), wy);
  return lerp(bottom, top, wz);
}

function fractal(x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let frequency = 1;
  let amplitude = 1;
  let weight = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += perlin(x * frequency, y * frequency, z * frequency) * amplitude;
    weight += amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }
  return sum / weight;
}

export function sampleDemoSurface(direction: Vec3): SurfaceSample {
  return samplePlanetSurface(direction, SEAM_TEST_PLANET);
}

export function samplePlanetSurface(direction: Vec3, preset: PlanetPreset): SurfaceSample {
  const terrain = preset.terrain;
  const { x, y, z } = direction;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-6) {
    throw new Error(`DemoSurface.ts samplePlanetSurface: expected unit direction; preset=${preset.name}; direction=${JSON.stringify(direction)}; length=${length}`);
  }

  const warpX = fractal(x * terrain.warpFrequency + terrain.warpOffsets[0], y * terrain.warpFrequency, z * terrain.warpFrequency, terrain.warpOctaves) * terrain.warpStrength;
  const warpY = fractal(x * terrain.warpFrequency, y * terrain.warpFrequency + terrain.warpOffsets[1], z * terrain.warpFrequency, terrain.warpOctaves) * terrain.warpStrength;
  const warpZ = fractal(x * terrain.warpFrequency, y * terrain.warpFrequency, z * terrain.warpFrequency + terrain.warpOffsets[2], terrain.warpOctaves) * terrain.warpStrength;
  const px = x + warpX, py = y + warpY, pz = z + warpZ;
  const continent = fractal(px * terrain.continentFrequency, py * terrain.continentFrequency, pz * terrain.continentFrequency, terrain.continentOctaves);
  const land = smoothstep(terrain.coastStart, terrain.coastEnd, continent);
  const ridgeA = 1 - Math.min(1, Math.abs(perlin(px * terrain.ridgeFrequencies[0], py * terrain.ridgeFrequencies[0], pz * terrain.ridgeFrequencies[0])));
  const ridgeB = 1 - Math.min(1, Math.abs(perlin(px * terrain.ridgeFrequencies[1], py * terrain.ridgeFrequencies[1], pz * terrain.ridgeFrequencies[1])));
  const ridgeC = 1 - Math.min(1, Math.abs(perlin(px * terrain.ridgeFrequencies[2], py * terrain.ridgeFrequencies[2], pz * terrain.ridgeFrequencies[2])));
  const mountains = terrain.ridgeWeights[0] * ridgeA ** terrain.ridgePowers[0] +
    terrain.ridgeWeights[1] * ridgeB ** terrain.ridgePowers[1] +
    terrain.ridgeWeights[2] * ridgeC ** terrain.ridgePowers[2];
  const heightMeters = preset.maxSurfaceHeightMeters * land * (terrain.landBaseHeightFraction + terrain.landMountainHeightFraction * mountains);

  const color: readonly [number, number, number] = land < 0.02
    ? [terrain.oceanColor[0], terrain.oceanColor[1] + 0.07 * land, terrain.oceanColor[2]]
    : heightMeters > terrain.snowHeightMeters
      ? terrain.snowColor
      : heightMeters > terrain.rockHeightMeters
        ? terrain.rockColor
        : [0.13 + 0.12 * land, 0.25 + 0.1 * land, 0.12];
  return { heightMeters, color };
}
