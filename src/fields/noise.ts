/** Small, versioned noise primitives shared by planet proxies and terrain workers. */
export const PLANET_NOISE_VERSION = 1;

export type Vec3Like = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

/** Convert arbitrary persisted seeds into the same unsigned 32-bit seed. */
export function normalizeSeed(seed: number | string | undefined): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return seed >>> 0;
  }

  const text = String(seed ?? 'void-explorer');
  let value = 2_166_136_261;

  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }

  return value >>> 0;
}

export function hashCoordinates(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  let value = seed ^ Math.imul(x, 374_761_393);
  value ^= Math.imul(y, 668_265_263);
  value ^= Math.imul(z, 2_147_483_647);
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return (value ^ (value >>> 16)) >>> 0;
}

export function hashUnit(value: number): number {
  let hashed = value | 0;
  hashed = Math.imul(hashed ^ (hashed >>> 16), 0x7feb352d);
  hashed = Math.imul(hashed ^ (hashed >>> 15), 0x846ca68b);
  return ((hashed ^ (hashed >>> 16)) >>> 0) / 4_294_967_295;
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function mix(start: number, end: number, blend: number): number {
  return start + (end - start) * blend;
}

/** Continuous 3D value noise. Sampling on a unit direction avoids cube-face seams. */
export function valueNoise3(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const gridX = Math.floor(x);
  const gridY = Math.floor(y);
  const gridZ = Math.floor(z);
  const blendX = smoothstep(x - gridX);
  const blendY = smoothstep(y - gridY);
  const blendZ = smoothstep(z - gridZ);
  const scale = 2 / 4_294_967_295;

  const corner = (offsetX: number, offsetY: number, offsetZ: number): number =>
    hashCoordinates(gridX + offsetX, gridY + offsetY, gridZ + offsetZ, seed) *
      scale -
    1;

  const lowerY0 = mix(corner(0, 0, 0), corner(1, 0, 0), blendX);
  const lowerY1 = mix(corner(0, 1, 0), corner(1, 1, 0), blendX);
  const upperY0 = mix(corner(0, 0, 1), corner(1, 0, 1), blendX);
  const upperY1 = mix(corner(0, 1, 1), corner(1, 1, 1), blendX);

  return mix(mix(lowerY0, lowerY1, blendY), mix(upperY0, upperY1, blendY), blendZ);
}

export interface FractalNoiseOptions {
  octaves?: number;
  frequency?: number;
  lacunarity?: number;
  persistence?: number;
  seed?: number;
}

export function fractalNoise3(
  direction: Vec3Like,
  options: FractalNoiseOptions = {},
): number {
  const octaves = Math.max(1, Math.min(8, options.octaves ?? 4));
  let frequency = options.frequency ?? 1;
  let amplitude = 1;
  let value = 0;
  let totalAmplitude = 0;
  const persistence = options.persistence ?? 0.52;
  const lacunarity = options.lacunarity ?? 2.07;
  const seed = options.seed ?? 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    value +=
      valueNoise3(
        direction.x * frequency,
        direction.y * frequency,
        direction.z * frequency,
        (seed + Math.imul(octave, 0x9e3779b9)) >>> 0,
      ) * amplitude;
    totalAmplitude += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return value / totalAmplitude;
}

export function ridgeNoise3(
  direction: Vec3Like,
  options: FractalNoiseOptions = {},
): number {
  const octaves = Math.max(1, Math.min(6, options.octaves ?? 3));
  let frequency = options.frequency ?? 4;
  let amplitude = 0.65;
  let value = 0;
  let totalAmplitude = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const sample = valueNoise3(
      direction.x * frequency,
      direction.y * frequency,
      direction.z * frequency,
      ((options.seed ?? 0) + Math.imul(octave, 0x85ebca6b)) >>> 0,
    );
    const ridge = 1 - Math.abs(sample);
    value += ridge * ridge * amplitude;
    totalAmplitude += amplitude;
    amplitude *= options.persistence ?? 0.54;
    frequency *= options.lacunarity ?? 2.03;
  }

  return value / totalAmplitude;
}
