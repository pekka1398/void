import { float, screenCoordinate, uint } from 'three/tsl';
import type { Node } from 'three/webgpu';

import type { Vec3Like } from '../fields/noise';

/** Angular, body-fixed cells; neither the camera nor a tile's local origin is part of the identity. */
export const TERRAIN_LOD_DISSOLVE_CELLS = 65_536;
const HASH_X = 73_856_093;
const HASH_Y = 19_349_663;
const HASH_Z = 83_492_791;
const HASH_STATE_MULTIPLIER = 747_796_405;
const HASH_STATE_INCREMENT = 2_891_336_453;
const HASH_WORD_MULTIPLIER = 277_803_737;
const FLOAT_BUCKETS = 16_777_216;

function clampAlpha(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** The CPU side of the unsigned PCG hash used by the actual TSL coverage masks. */
function lodHash(seed: number): number {
  const state = (Math.imul(seed, HASH_STATE_MULTIPLIER) + HASH_STATE_INCREMENT) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, HASH_WORD_MULTIPLIER) >>> 0;
  // Top 24 bits are exactly representable by a GPU float and can never round to 1.
  return (((word >>> 22) ^ word) >>> 8) / FLOAT_BUCKETS;
}

function lodHashNode(key: Node<'uint'>): Node<'float'> {
  const state = key.mul(uint(HASH_STATE_MULTIPLIER)).add(uint(HASH_STATE_INCREMENT));
  const word = state.shiftRight(state.shiftRight(uint(28)).add(uint(4)))
    .bitXor(state).mul(uint(HASH_WORD_MULTIPLIER));
  return word.shiftRight(uint(22)).bitXor(word).shiftRight(uint(8)).toFloat().mul(1 / FLOAT_BUCKETS);
}

/**
 * Actual framebuffer-pixel presentation noise. Three r185 screenCoordinate
 * follows WebGPU's top-left convention and flips WebGL fragment Y against the
 * bound framebuffer height. Using absolute physical pixels (not a mesh UV or
 * viewport-local origin) gives every surface in one render pass the same key.
 */
export function screenSpaceLodNoise(seed: number): Node<'float'> {
  const pixel = screenCoordinate.floor();
  return lodHashNode(uint(seed >>> 0).bitXor(pixel.x.toUint().mul(uint(HASH_X)))
    .bitXor(pixel.y.toUint().mul(uint(HASH_Y))));
}

/** CPU mirror for top-left, physical framebuffer pixel coordinates. */
export function sampleScreenSpaceLodNoise(x: number, y: number, seed: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return lodHash((seed >>> 0) ^ Math.imul(Math.floor(x), HASH_X) ^ Math.imul(Math.floor(y), HASH_Y));
}

/** Stable [0,1) coverage value at a real body-fixed radial direction. */
export function sampleBodyFixedLodNoise(direction: Vec3Like, seed: number): number {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length <= Number.EPSILON) return 0;
  const cell = (component: number) => Math.floor((component / length + 1) * TERRAIN_LOD_DISSOLVE_CELLS);
  const key = (seed >>> 0) ^ Math.imul(cell(direction.x), HASH_X) ^
    Math.imul(cell(direction.y), HASH_Y) ^ Math.imul(cell(direction.z), HASH_Z);
  return lodHash(key);
}

/**
 * Geographic-noise counterpart, not a raster ownership mask. Differently
 * tessellated surfaces can intersect one camera ray at different directions;
 * use screenSpaceLodNoise for a complementary presentation dissolve.
 */
export function bodyFixedLodNoise(bodyPosition: Node<'vec3'>, seed: number): Node<'float'> {
  const cell = bodyPosition.normalize().add(1).mul(TERRAIN_LOD_DISSOLVE_CELLS).floor();
  const key = uint(seed >>> 0).bitXor(cell.x.toUint().mul(uint(HASH_X)))
    .bitXor(cell.y.toUint().mul(uint(HASH_Y))).bitXor(cell.z.toUint().mul(uint(HASH_Z)));
  return lodHashNode(key);
}

/** Half-open intervals make outgoing and incoming opaque surfaces complementary. */
export function lodIntervalMask(
  noise: Node<'float'>,
  lower: Node<'float'> | number,
  upper: Node<'float'> | number,
): Node<'bool'> {
  return noise.greaterThanEqual(typeof lower === 'number' ? float(lower) : lower)
    .and(noise.lessThan(typeof upper === 'number' ? float(upper) : upper));
}

export function lodIntervalContains(noise: number, lower: number, upper: number): boolean {
  return Number.isFinite(noise) && noise >= clampAlpha(lower) && noise < clampAlpha(upper);
}

/** Reversible, bounded progression; no elapsed wall-clock history is retained. */
export function advanceLodProgress(current: number, target: number, deltaSeconds: number, durationSeconds: number): number {
  const from = clampAlpha(current);
  const to = clampAlpha(target);
  const step = Math.max(0, Math.min(0.25, Number.isFinite(deltaSeconds) ? deltaSeconds : 0)) /
    Math.max(0.001, Number.isFinite(durationSeconds) ? durationSeconds : 0.35);
  return from < to ? Math.min(to, from + step) : Math.max(to, from - step);
}
