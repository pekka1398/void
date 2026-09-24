import type { Vec3 } from '../core';
import type { CelestialLightFrame, SpectralRgb } from './CelestialLighting';

export interface WorldIndirectLightingOptions {
  readonly nearSurface: boolean;
  readonly atmosphereFactor: number;
  readonly cloudDensity: number;
}

export interface WorldIndirectLightingState {
  /** Linear RGB values; pass directly to the existing Three light colors. */
  readonly ambientColor: SpectralRgb;
  readonly skyColor: SpectralRgb;
  readonly groundColor: SpectralRgb;
  readonly ambientIntensity: number;
  readonly skyIntensity: number;
  /** The real dominant star's world direction, or stable world-up. */
  readonly sourceDirectionWorld: Vec3;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function linearComponent(component: number): number {
  return component <= 0.04045
    ? component / 12.92
    : ((component + 0.055) / 1.055) ** 2.4;
}

function linearRgb(hex: number): SpectralRgb {
  return {
    r: linearComponent(((hex >> 16) & 255) / 255),
    g: linearComponent(((hex >> 8) & 255) / 255),
    b: linearComponent((hex & 255) / 255),
  };
}

function mix(first: SpectralRgb, second: SpectralRgb, amount: number): SpectralRgb {
  return {
    r: first.r + (second.r - first.r) * amount,
    g: first.g + (second.g - first.g) * amount,
    b: first.b + (second.b - first.b) * amount,
  };
}

const NIGHT_AMBIENT = linearRgb(0x9385df);
const NIGHT_SKY = linearRgb(0x713cdf);
const NIGHT_GROUND = linearRgb(0x083a52);
const DAY_AMBIENT = linearRgb(0xe8f1ff);
const DAY_SKY = linearRgb(0xddeaff);
const DAY_GROUND = linearRgb(0x25345c);
const WHITE: SpectralRgb = { r: 1, g: 1, b: 1 };

function receivedStellarColor(frame: CelestialLightFrame): SpectralRgb {
  const weights = frame.sources.map((source) => source.active && source.id
    ? positiveFinite(source.receivedIrradianceSolar)
    : 0);
  // Normalize first so even unusually large finite irradiances cannot overflow
  // the three-source weighted sum.
  const maximumWeight = Math.max(...weights);
  if (maximumWeight <= 0) return WHITE;

  let totalWeight = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  frame.sources.forEach((source, index) => {
    const weight = weights[index]! / maximumWeight;
    totalWeight += weight;
    r += clamp01(source.spectralColor.r) * weight;
    g += clamp01(source.spectralColor.g) * weight;
    b += clamp01(source.spectralColor.b) * weight;
  });
  return { r: r / totalWeight, g: g / totalWeight, b: b / totalWeight };
}

function dominantSourceDirection(frame: CelestialLightFrame): Vec3 {
  const source = frame.sources[frame.dominantSlot];
  if (source?.active && source.id) {
    const { x, y, z } = source.directionWorld;
    const length = Math.hypot(x, y, z);
    if (Number.isFinite(length) && length > 1e-12) {
      return { x: x / length, y: y / length, z: z / length };
    }
  }
  return { x: 0, y: 1, z: 0 };
}

/**
 * Bounded diffuse-light approximation for the existing shared world lights.
 * It reads one authoritative celestial frame, keeps genuine night indigo,
 * and lets daylight reveal neutral hull/terrain colors. It neither creates
 * lights nor changes any receiver's direct stellar visibility.
 */
export function resolveWorldIndirectLighting(
  frame: CelestialLightFrame,
  options: WorldIndirectLightingOptions,
): WorldIndirectLightingState {
  const daylight = clamp01(frame.daylight);
  const twilight = clamp01(frame.twilight);
  const atmosphere = clamp01(options.atmosphereFactor);
  const clouds = clamp01(options.cloudDensity);
  const dayMix = clamp01(daylight + twilight * 0.35);
  const stellarColor = receivedStellarColor(frame);

  // Retain the existing surface day/night response. Only the daylight color
  // balance changes; open space gets a modest received-energy-dependent lift.
  const spaceEnergy = Math.sqrt(clamp01(frame.totalIrradianceSolar));
  const ambientIntensity = options.nearSurface
    ? Math.min(0.60, 0.115 + daylight * 0.19 +
      atmosphere * (0.065 + daylight * 0.19 + twilight * 0.045) + clouds * 0.022)
    : 0.115 + spaceEnergy * 0.225;
  const skyIntensity = options.nearSurface
    ? Math.min(0.40, 0.045 + daylight * 0.095 +
      atmosphere * (0.055 + daylight * 0.18 + twilight * 0.055) + clouds * 0.018)
    : 0.045 + spaceEnergy * 0.135;

  return {
    ambientColor: mix(NIGHT_AMBIENT, mix(stellarColor, DAY_AMBIENT, 0.78), dayMix),
    skyColor: mix(NIGHT_SKY, mix(stellarColor, DAY_SKY, 0.82), dayMix),
    groundColor: mix(NIGHT_GROUND, DAY_GROUND, daylight),
    ambientIntensity,
    skyIntensity,
    sourceDirectionWorld: dominantSourceDirection(frame),
  };
}
