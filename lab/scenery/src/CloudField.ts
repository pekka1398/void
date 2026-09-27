import type { Vec3 } from './Atmosphere';
import { noise } from './LayeredTerrain';

/** Heights above the live sea level, never above the ocean-floor reference sphere. */
export const CLOUD_BOTTOM = 1500;
export const CLOUD_TOP = 8000;
export const CLOUD_EXTINCTION = 0.0011; // m⁻¹ at unit density
export const SHAPE_PERIOD = 65536;
export const DETAIL_PERIOD = 2048;
export const WEATHER_WIDTH = 2048;
export const WEATHER_HEIGHT = 1024;
export const SHAPE_SIZE = 64;
export const DETAIL_SIZE = 32;
export const DEFAULT_CLOUD_COVERAGE = 0.62;

const clamp = (v: number) => Math.max(0, Math.min(1, v));
export function cloudSmooth(a: number, b: number, v: number): number {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Global weather on body-fixed directions. No cube-face coordinates or tile state. */
export function cloudWeather(d: Vec3): readonly [number, number] {
  const latitude = Math.asin(Math.max(-1, Math.min(1, d.z)));
  // Warp broad weather systems before adding weaker regional structure.
  const x = d.x + 0.18 * noise(d.x * 3 + 71, d.y * 3, d.z * 3);
  const y = d.y + 0.18 * noise(d.x * 3, d.y * 3 + 29, d.z * 3);
  const z = d.z + 0.18 * noise(d.x * 3, d.y * 3, d.z * 3 + 13);
  const humidity = clamp(0.55 + 1.1 * noise(x * 7 + 41, y * 7, z * 7)
    + 0.6 * noise(x * 23, y * 23 + 17, z * 23)
    + 0.18 * noise(x * 47 + 7, y * 47, z * 47)
    + 0.06 * noise(x * 89, y * 89 + 53, z * 89) + 0.12 * Math.cos(latitude * 4));
  const type = clamp(0.45 + 0.5 * noise(d.x * 11, d.y * 11, d.z * 11 + 31)
    + 0.25 * Math.cos(latitude * 2));
  return [humidity, type];
}

export function weatherCoverage(humidity: number, amount = DEFAULT_CLOUD_COVERAGE): number {
  return cloudSmooth(0.3, 0.65, humidity + (amount - DEFAULT_CLOUD_COVERAGE) * 1.5) * 0.9;
}

/** R = humidity, G = vertical type (thin stratiform → deep cumulus). */
export function buildCloudWeather(): Uint8Array {
  const data = new Uint8Array(WEATHER_WIDTH * WEATHER_HEIGHT * 4);
  for (let y = 0; y < WEATHER_HEIGHT; y++) {
    const latitude = Math.PI * (y / (WEATHER_HEIGHT - 1) - 0.5);
    for (let x = 0; x < WEATHER_WIDTH; x++) {
      const longitude = Math.PI * (2 * x / WEATHER_WIDTH - 1);
      const [humidity, type] = cloudWeather({ x: Math.cos(latitude) * Math.cos(longitude),
        y: Math.cos(latitude) * Math.sin(longitude), z: Math.sin(latitude) });
      const i = (y * WEATHER_WIDTH + x) * 4;
      data[i] = Math.round(humidity * 255);
      data[i + 1] = Math.round(type * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

function hash(x: number, y: number, z: number, period: number, seed: number): number {
  const wrap = (v: number) => ((v % period) + period) % period;
  let h = Math.imul(wrap(x), 374761393) ^ Math.imul(wrap(y), 668265263)
    ^ Math.imul(wrap(z), 1442695041) ^ Math.imul(seed, 1597334677);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, z: number, period: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const f = (v: number) => { const t = v - Math.floor(v); return t * t * (3 - 2 * t); };
  const u = f(x), v = f(y), w = f(z);
  let sum = 0;
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    sum += hash(ix + dx, iy + dy, iz + dz, period, 1)
      * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return sum;
}

/** Periodic gradient Perlin, remapped to 0–1. Feature gradients wrap across the volume boundary. */
function perlinNoise(x: number, y: number, z: number, period: number): number {
  const gradients = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(fx), v = fade(fy), w = fade(fz);
  let sum = 0;
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const g = gradients[Math.floor(hash(ix + dx, iy + dy, iz + dz, period, 5) * 12)]!;
    sum += (g[0]! * (fx - dx) + g[1]! * (fy - dy) + g[2]! * (fz - dz)) * 0.7071067811865476
      * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return clamp(0.5 + sum);
}

/** Inverted periodic Worley F1, wrapping feature cells as well as texture coordinates. */
function worley(x: number, y: number, z: number, period: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let nearest = Infinity;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const a = cx + hash(cx, cy, cz, period, 2) - x;
    const b = cy + hash(cx, cy, cz, period, 3) - y;
    const c = cz + hash(cx, cy, cz, period, 4) - z;
    nearest = Math.min(nearest, a * a + b * b + c * c);
  }
  return 1 - clamp(Math.sqrt(nearest));
}

/** Samples are at texel centres; linear repeat filtering therefore agrees at the seam. */
export function buildCloudNoise(size: number, detail: boolean): Uint8Array {
  const data = new Uint8Array(size ** 3 * 4);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const qx = (x + 0.5) / size, qy = (y + 0.5) / size, qz = (z + 0.5) / size;
    const cells = detail ? 4 : 8;
    const w = worley(qx * cells, qy * cells, qz * cells, cells);
    const perlin = perlinNoise(qx * cells, qy * cells, qz * cells, cells);
    const fine = valueNoise(qx * cells * 2, qy * cells * 2, qz * cells * 2, cells * 2);
    const i = ((z * size + y) * size + x) * 4;
    data[i] = Math.round(clamp(detail ? w : (0.65 * perlin + 0.35 * w - 0.25) / 0.5) * 255);
    data[i + 1] = Math.round(fine * 255);
    // A separate smooth, low-frequency field organizes regional cloud banks.
    data[i + 2] = Math.round(perlinNoise(qx * 2, qy * 2, qz * 2, 2) * 255);
    data[i + 3] = 255;
  }
  return data;
}

/** CPU reference for the GPU's repeating, trilinear 3D lookup. */
export function sampleCloudNoise(data: Uint8Array, size: number, p: Vec3, period: number, channel = 0): number {
  const coordinate = (v: number) => v / period * size - 0.5;
  const q = [coordinate(p.x), coordinate(p.y), coordinate(p.z)];
  const wrap = (v: number) => ((v % size) + size) % size;
  let sum = 0;
  for (let z = 0; z <= 1; z++) for (let y = 0; y <= 1; y++) for (let x = 0; x <= 1; x++) {
    const i = q.map((v, axis) => wrap(Math.floor(v) + [x, y, z][axis]!));
    const f = q.map(v => v - Math.floor(v));
    sum += data[((i[2]! * size + i[1]!) * size + i[0]!) * 4 + channel]! / 255
      * (x ? f[0]! : 1 - f[0]!) * (y ? f[1]! : 1 - f[1]!) * (z ? f[2]! : 1 - f[2]!);
  }
  return sum;
}

/** Same remap/profile as CloudShading.density, for independent density and optical-depth checks. */
export function cloudDensity(heightASL: number, humidity: number, type: number, shape: number,
  detail: number, amount = DEFAULT_CLOUD_COVERAGE, detailWeight = 1, footprint = 0, macroShape = 1): number {
  const bank = cloudSmooth(0.15, 0.7, macroShape);
  const unresolved = cloudSmooth(2000, 16000, footprint);
  const topShape = shape * (1 - unresolved) + 0.5 * unresolved;
  const top = CLOUD_BOTTOM + (2000 + 4500 * type) * (0.2 + 0.8 * bank) * (0.45 + 0.55 * topShape);
  const h = (heightASL - CLOUD_BOTTOM) / (top - CLOUD_BOTTOM);
  const profile = cloudSmooth(0, 0.08, h) * (1 - cloudSmooth(0.35, 1, h));
  const coverage = weatherCoverage(humidity, amount);
  const cells = clamp((shape - h * h * 0.25 - (1 - coverage)) / Math.max(coverage, 0.001));
  // Moist systems join into sheets; dry margins retain separate cumulus cells.
  const sheet = cloudSmooth(0.55, 0.85, coverage) * (1 - 0.6 * type);
  const base = cells * (1 - sheet) + 0.32 * coverage * sheet;
  const filteredBase = base * (1 - unresolved) + (coverage ** 3 * 0.45 * (1 - sheet) + 0.32 * coverage * sheet) * clamp(1 - h * h * 0.6) * unresolved;
  return clamp(filteredBase * profile - (1 - detail) * 0.16 * detailWeight) * (0.45 + 0.55 * type) * cloudSmooth(0.05, 0.5, bank);
}

/** Exact shell intervals; includes the far segment when a ray passes through the hollow interior. */
export function cloudShellIntervals(origin: Vec3, direction: Vec3, inner: number, outer: number,
  sceneDistance = Infinity): readonly (readonly [number, number])[] {
  const r = Math.hypot(origin.x, origin.y, origin.z);
  const mu = (origin.x * direction.x + origin.y * direction.y + origin.z * direction.z) / r;
  const roots = (radius: number): readonly [number, number] | null => {
    const altitude = r - radius;
    const d = r * r * mu * mu - altitude * (2 * radius + altitude);
    return d >= 0 ? [-r * mu - Math.sqrt(d), -r * mu + Math.sqrt(d)] : null;
  };
  const outside = roots(outer);
  if (!outside) return [];
  const start = Math.max(0, outside[0]), end = Math.min(sceneDistance, outside[1]);
  if (!(end > start)) return [];
  const inside = roots(inner);
  if (!inside) return [[start, end]];
  return [[start, Math.min(end, inside[0])], [Math.max(start, inside[1]), end]]
    .filter(([a, b]) => b! > a!) as [number, number][];
}
