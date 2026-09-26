import type { Vec3 } from './Atmosphere';

/**
 * A planet built in layers, each at its own scale, so it reads as a planet
 * from 20,000 km and as ground from 2 m:
 *
 * 1. Continents (thousands of km): domain-warped fBm; its sign is land or sea.
 *    Sea falls to a 150 m shelf, then to 4.5 km deep basins; land rises
 *    slowly inland.
 * 2. Mountain belts (hundreds of km): narrow bands along the zero lines of a
 *    low-frequency noise, like ranges along plate edges, on land and at coasts.
 *    Inside a belt, ridged multifractal noise (Musgrave) makes the ranges.
 * 3. Hills down to metres: fBm whose octaves are damped where the ground
 *    already slopes (Quilez's "eroded" fBm), so slopes grow gullies and
 *    ridges, and flat ground stays flat. How rough the hills are depends on the
 *    region and is highest in the belts.
 *
 * Heights are measured from the ocean floor's reference sphere (never
 * negative, as lab/lod requires); sea level is SEA_LEVEL above it. Octaves
 * finer than about 2–4 tile cells are faded out, as a mipmap would.
 */
export const SEA_LEVEL = 5000;
export const MAX_HEIGHT = 16_000;

export interface LayeredOptions {
  readonly radiusMeters: number;
  readonly seed: number;
}

export const DEFAULT_LAYERED: LayeredOptions = { radiusMeters: 6_371_000, seed: 7 };

/** Octave wavelengths, metres. */
const HILL_LONGEST = 60_000;
const HILL_SHORTEST = 8;
const MOUNTAIN_LONGEST = 220_000;
const MOUNTAIN_SHORTEST = 1_500;

export function layeredTerrain(options: LayeredOptions): (direction: Vec3, cellMeters: number) => { heightMeters: number; color: readonly [number, number, number] } {
  const { radiusMeters: R, seed } = options;
  if (!(R > 0) || !Number.isInteger(seed)) throw new RangeError(`layeredTerrain: ${JSON.stringify(options)}`);
  const offset = (k: number): number => ((seed * 7919 + k * 104729) % 1000) + 0.37 * k;
  const gradient = { x: 0, y: 0, z: 0 };

  return (d, cellMeters) => {
    const length = Math.hypot(d.x, d.y, d.z);
    if (!(Math.abs(length - 1) < 1e-6)) throw new RangeError(`layeredTerrain: not a unit direction ${JSON.stringify(d)}`);
    if (!(cellMeters > 0)) throw new RangeError(`layeredTerrain: cellMeters ${cellMeters}`);
    /** 1 for wavelengths well above the cell, fading to 0 at two cells. */
    const resolved = (wavelength: number): number => smoothstep(2 * cellMeters, 4 * cellMeters, wavelength);

    // 1. Continents, on a warped sphere.
    const wx = fbm(d.x * 2 + offset(1), d.y * 2, d.z * 2, 3);
    const wy = fbm(d.x * 2, d.y * 2 + offset(2), d.z * 2, 3);
    const wz = fbm(d.x * 2, d.y * 2, d.z * 2 + offset(3), 3);
    const qx = d.x + 0.3 * wx, qy = d.y + 0.3 * wy, qz = d.z + 0.3 * wz;
    const continent = fbm(qx * 1.4 + offset(4), qy * 1.4, qz * 1.4, 6) - 0.06;
    const land = smoothstep(0, 0.02, continent);
    let elevation = continent >= 0
      ? 60 * smoothstep(0, 0.003, continent) + 500 * smoothstep(0.02, 0.35, continent)
      : -150 * smoothstep(0, -0.02, continent) - 4300 * smoothstep(-0.02, -0.15, continent);

    // 2. Mountain belts: near the zero lines of a low-frequency noise.
    const beltNoise = fbm(qx * 3 + offset(5), qy * 3, qz * 3, 3);
    const belt = smoothstep(0.1, 0.02, Math.abs(beltNoise)) * smoothstep(-0.03, 0.08, continent);
    const beltStrength = 0.45 + 0.55 * smoothstep(-0.3, 0.3, noise(qx * 9 + offset(6), qy * 9, qz * 9));
    if (belt > 0) {
      let sum = 0, weight = 1, amplitude = 1, norm = 0;
      for (let wavelength = MOUNTAIN_LONGEST; wavelength >= MOUNTAIN_SHORTEST; wavelength /= 2) {
        const f = R / wavelength;
        const ridge = 1 - Math.abs(noise(d.x * f + offset(7), d.y * f, d.z * f));
        const signal = ridge * ridge * weight;
        weight = Math.min(1, signal * 2);
        const fade = resolved(wavelength);
        sum += signal * amplitude * fade;
        norm += amplitude;
        amplitude *= 0.6;
      }
      // Squared: valleys between the ridges stay low and the peaks sharpen, instead of one raised plateau.
      const ridges = (sum / norm) * 1.6;
      elevation += 4200 * belt * beltStrength * ridges * ridges;
    }

    // 3. Hills: eroded fBm, rougher in the belts and in rough regions, gentle on plains and the sea floor.
    const region = smoothstep(-0.25, 0.35, noise(qx * 7 + offset(8), qy * 7, qz * 7));
    const hillAmplitude = (160 + 380 * region + 3200 * belt) * (0.25 + 0.75 * land);
    let slopeX = 0, slopeY = 0, slopeZ = 0;
    let hills = 0;
    let amplitude = hillAmplitude;
    for (let wavelength = HILL_LONGEST; wavelength >= HILL_SHORTEST; wavelength /= 2) {
      const fade = resolved(wavelength);
      if (fade === 0) break;
      const f = R / wavelength;
      const n = noiseWithGradient(d.x * f + offset(9), d.y * f, d.z * f, gradient);
      // Slope this octave adds, metres per metre, along the surface (the radial part is dropped).
      const along = gradient.x * d.x + gradient.y * d.y + gradient.z * d.z;
      const scale = (amplitude * f) / R;
      slopeX += (gradient.x - along * d.x) * scale;
      slopeY += (gradient.y - along * d.y) * scale;
      slopeZ += (gradient.z - along * d.z) * scale;
      const damping = 1 / (1 + 1.5 * (slopeX * slopeX + slopeY * slopeY + slopeZ * slopeZ));
      hills += amplitude * n * damping * fade;
      // Rough regions keep more of their small-scale relief.
      amplitude *= 0.5 + 0.04 * region + 0.04 * belt;
    }
    elevation += hills;

    const heightMeters = Math.min(MAX_HEIGHT, Math.max(0, SEA_LEVEL + elevation));
    const color = elevation < 0 ? SEA_FLOOR : groundCover(d, qx, qy, qz, elevation, belt, resolved);
    return { heightMeters, color };
  };
}

const SEA_FLOOR: readonly [number, number, number] = [0.12, 0.11, 0.08];
const DESERT = [0.36, 0.27, 0.16] as const;
const STEPPE = [0.19, 0.17, 0.09] as const;
const GRASS = [0.075, 0.12, 0.04] as const;
const FOREST = [0.03, 0.06, 0.025] as const;
const TUNDRA = [0.14, 0.13, 0.1] as const;

/**
 * What covers the land, as a linear albedo (the shader adds beaches, rock and snow on top):
 * a wetness from continental-scale noise, dried in the subtropical belts (about 25° from the
 * equator) and in the lee of mountain belts, picks desert, steppe, grass or forest; the far
 * north and south turn to tundra. Patches of a few kilometres down to tens of metres break it
 * up, band-limited like the heights.
 */
function groundCover(d: Vec3, qx: number, qy: number, qz: number, elevation: number, belt: number, resolved: (wavelength: number) => number): readonly [number, number, number] {
  const latitude = Math.asin(Math.max(-1, Math.min(1, d.z)));
  const subtropics = Math.exp(-(((Math.abs(latitude) - 0.44) / 0.14) ** 2));
  const wetness = 0.55 + 0.9 * fbm(qx * 2.5 + 311, qy * 2.5, qz * 2.5, 4) - 0.55 * subtropics - 0.2 * belt - elevation / 12_000;
  let patches = 0, weight = 0;
  // Wavelengths 6.4 km down to 25 m, in the same radius units as the heights (6,371 km).
  for (let wavelength = 6400, a = 1; wavelength >= 25; wavelength /= 2, a *= 0.8) {
    patches += a * resolved(wavelength) * noise(d.x * (6_371_000 / wavelength) + 71, d.y * (6_371_000 / wavelength), d.z * (6_371_000 / wavelength));
    weight += a;
  }
  const w = Math.min(1, Math.max(0, wetness + 0.5 * (patches / weight) * 2));
  const mixColor = (a: readonly number[], b: readonly number[], t: number) => [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t);
  let c = w < 0.25 ? mixColor(DESERT, STEPPE, w / 0.25) : w < 0.5 ? mixColor(STEPPE, GRASS, (w - 0.25) / 0.25) : mixColor(GRASS, FOREST, Math.min(1, (w - 0.5) / 0.3));
  c = mixColor(c, TUNDRA, smoothstep(0.95, 1.2, Math.abs(latitude)));
  const brightness = 1 + 0.4 * (patches / weight) * 2;
  return [c[0]! * brightness, c[1]! * brightness, c[2]! * brightness];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function fbm(x: number, y: number, z: number, octaves: number): number {
  let sum = 0, amplitude = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o += 1) {
    sum += amplitude * noise(x * f, y * f, z * f);
    norm += amplitude;
    amplitude *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

const GRADIENTS = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) % 12 * 3;
}

const discard = { x: 0, y: 0, z: 0 };
/** 3D gradient noise in about [-1, 1]. */
export function noise(x: number, y: number, z: number): number {
  return noiseWithGradient(x, y, z, discard);
}

/**
 * Gradient noise and its gradient (written to `out`) in one pass, from Quilez's
 * analytic derivative of quintic-interpolated Perlin noise.
 */
export function noiseWithGradient(x: number, y: number, z: number, out: { x: number; y: number; z: number }): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1), duz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const a = hash(ix, iy, iz), b = hash(ix + 1, iy, iz), c = hash(ix, iy + 1, iz), dd = hash(ix + 1, iy + 1, iz);
  const e = hash(ix, iy, iz + 1), f = hash(ix + 1, iy, iz + 1), g = hash(ix, iy + 1, iz + 1), h = hash(ix + 1, iy + 1, iz + 1);
  const G = GRADIENTS;
  const va = G[a]! * fx + G[a + 1]! * fy + G[a + 2]! * fz;
  const vb = G[b]! * (fx - 1) + G[b + 1]! * fy + G[b + 2]! * fz;
  const vc = G[c]! * fx + G[c + 1]! * (fy - 1) + G[c + 2]! * fz;
  const vd = G[dd]! * (fx - 1) + G[dd + 1]! * (fy - 1) + G[dd + 2]! * fz;
  const ve = G[e]! * fx + G[e + 1]! * fy + G[e + 2]! * (fz - 1);
  const vf = G[f]! * (fx - 1) + G[f + 1]! * fy + G[f + 2]! * (fz - 1);
  const vg = G[g]! * fx + G[g + 1]! * (fy - 1) + G[g + 2]! * (fz - 1);
  const vh = G[h]! * (fx - 1) + G[h + 1]! * (fy - 1) + G[h + 2]! * (fz - 1);
  const k1 = vb - va, k2 = vc - va, k3 = ve - va;
  const k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf;
  const k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  const value = va + ux * k1 + uy * k2 + uz * k3 + ux * uy * k4 + uy * uz * k5 + uz * ux * k6 + ux * uy * uz * k7;
  for (let axis = 0; axis < 3; axis += 1) {
    const ga = G[a + axis]!, gb = G[b + axis]!, gc = G[c + axis]!, gd = G[dd + axis]!;
    const ge = G[e + axis]!, gf = G[f + axis]!, gg = G[g + axis]!, gh = G[h + axis]!;
    const gradients = ga + ux * (gb - ga) + uy * (gc - ga) + uz * (ge - ga) + ux * uy * (ga - gb - gc + gd)
      + uy * uz * (ga - gc - ge + gg) + uz * ux * (ga - gb - ge + gf) + ux * uy * uz * (-ga + gb + gc - gd + ge - gf - gg + gh);
    const interpolation = axis === 0 ? dux * (k1 + uy * k4 + uz * k6 + uy * uz * k7)
      : axis === 1 ? duy * (k2 + uz * k5 + ux * k4 + uz * ux * k7)
        : duz * (k3 + ux * k6 + uy * k5 + ux * uy * k7);
    const v = gradients + interpolation;
    if (axis === 0) out.x = v; else if (axis === 1) out.y = v; else out.z = v;
  }
  return value;
}
