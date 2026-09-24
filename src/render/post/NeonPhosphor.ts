export type NeonPhosphorMode = 'off' | 'subtle' | 'authentic' | 'clean';

export type NeonPhosphorQuality = 'high' | 'fallback';

/** Used only when no valid player-selected display preference is available. */
export const DEFAULT_NEON_PHOSPHOR_MODE: NeonPhosphorMode = 'authentic';

export interface NeonPhosphorColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Bounded display treatment only; authoritative bodies, lighting, and HUD remain unchanged. */
export interface NeonPhosphorSettings {
  readonly mode: NeonPhosphorMode;
  readonly quality: NeonPhosphorQuality;
  readonly enabled: boolean;
  readonly intensity: number;
  readonly paletteLevels: number;
  readonly ditherStrength: number;
  readonly ditherMatrixSize: 2 | 4;
  readonly scanlineStrength: number;
  readonly scanlinePitchPixels: number;
  readonly phosphorStrength: number;
  readonly phosphorPitchPixels: number;
  readonly horizontalBleedStrength: number;
  readonly horizontalBleedRadiusPixels: number;
  readonly blackFloor: number;
  readonly blackFeather: number;
  readonly highlightProtection: number;
  /** Scale the existing bounded presentation adjustments, not scene lighting. */
  readonly sharpenScale: number;
  readonly contrastScale: number;
}

/** Shared CPU/TSL thresholds for actual neighboring-pixel edge coverage. */
export const PHOSPHOR_EDGE_LIMITS = Object.freeze({
  absoluteStart: 0.025,
  absoluteFull: 0.12,
  relativeStart: 0.1,
  relativeFull: 0.32,
  detailStart: 0.006,
  detailFull: 0.025,
  luminanceFloor: 0.04,
});

const BAYER_2X2 = Object.freeze([
  0, 2,
  3, 1,
]);

const BAYER_4X4 = Object.freeze([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

function createSettings(
  mode: NeonPhosphorMode,
  quality: NeonPhosphorQuality,
): Readonly<NeonPhosphorSettings> {
  const fallback = quality === 'fallback';
  const authentic = mode === 'authentic';
  const clean = mode === 'clean';
  const enabled = mode === 'subtle' || authentic;
  return Object.freeze({
    mode,
    quality,
    enabled,
    intensity: enabled ? (authentic ? (fallback ? 0.68 : 0.78) : (fallback ? 0.38 : 0.45)) : 0,
    paletteLevels: enabled ? (authentic ? 64 : 96) : 256,
    ditherStrength: enabled ? (authentic ? (fallback ? 0.36 : 0.45) : (fallback ? 0.19 : 0.24)) : 0,
    ditherMatrixSize: (fallback ? 2 : 4) as 2 | 4,
    scanlineStrength: enabled ? (authentic ? (fallback ? 0.028 : 0.034) : (fallback ? 0.016 : 0.02)) : 0,
    scanlinePitchPixels: 2,
    phosphorStrength: enabled ? (authentic ? (fallback ? 0.088 : 0.11) : (fallback ? 0.052 : 0.065)) : 0,
    phosphorPitchPixels: 3,
    horizontalBleedStrength: enabled ? (authentic ? (fallback ? 0.05 : 0.065) : (fallback ? 0.026 : 0.035)) : 0,
    horizontalBleedRadiusPixels: 1,
    blackFloor: 0.009,
    blackFeather: 0.048,
    highlightProtection: enabled ? (authentic ? 0.86 : 0.72) : 1,
    sharpenScale: clean ? 0.25 : 1,
    contrastScale: clean ? 0.35 : 1,
  });
}

const PROFILES: Readonly<
  Record<NeonPhosphorQuality, Readonly<Record<NeonPhosphorMode, Readonly<NeonPhosphorSettings>>>>
> = Object.freeze({
  high: Object.freeze({
    off: createSettings('off', 'high'),
    subtle: createSettings('subtle', 'high'),
    authentic: createSettings('authentic', 'high'),
    clean: createSettings('clean', 'high'),
  }),
  fallback: Object.freeze({
    off: createSettings('off', 'fallback'),
    subtle: createSettings('subtle', 'fallback'),
    authentic: createSettings('authentic', 'fallback'),
    clean: createSettings('clean', 'fallback'),
  }),
});

export function normalizeNeonPhosphorMode(value: unknown): NeonPhosphorMode {
  if (typeof value !== 'string') return DEFAULT_NEON_PHOSPHOR_MODE;
  const normalized = value.trim().toLowerCase();
  return normalized === 'off' || normalized === 'subtle' || normalized === 'authentic' || normalized === 'clean'
    ? normalized
    : DEFAULT_NEON_PHOSPHOR_MODE;
}

/** Keep saved legacy looks and make Clean the first alternative to Authentic. */
export function cycleNeonPhosphorMode(mode: NeonPhosphorMode): NeonPhosphorMode {
  switch (normalizeNeonPhosphorMode(mode)) {
    case 'subtle': return 'authentic';
    case 'authentic': return 'clean';
    case 'clean': return 'off';
    case 'off': return 'subtle';
  }
}

/** Return canonical frozen profiles without allocating on rendered frames or mode changes. */
export function resolveNeonPhosphorSettings(
  mode: NeonPhosphorMode = DEFAULT_NEON_PHOSPHOR_MODE,
  quality: NeonPhosphorQuality = 'high',
): Readonly<NeonPhosphorSettings> {
  return PROFILES[quality][normalizeNeonPhosphorMode(mode)];
}

function wrappedPixel(value: number, size: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('Neon phosphor ordered dithering requires finite physical pixel coordinates.');
  }
  const integer = Math.floor(value);
  return ((integer % size) + size) % size;
}

/** Stable zero-mean physical-pixel threshold; never use simulation or frame time. */
export function bayer2x2(pixelX: number, pixelY: number): number {
  const x = wrappedPixel(pixelX, 2);
  const y = wrappedPixel(pixelY, 2);
  return (BAYER_2X2[y * 2 + x]! + 0.5) / 4 - 0.5;
}

/** Stable zero-mean physical-pixel threshold; never use simulation or frame time. */
export function bayer4x4(pixelX: number, pixelY: number): number {
  const x = wrappedPixel(pixelX, 4);
  const y = wrappedPixel(pixelY, 4);
  return (BAYER_4X4[y * 4 + x]! + 0.5) / 16 - 0.5;
}

/** Empty space remains exactly black and faint genuine catalog stars never receive artificial light. */
export function phosphorPresenceWeight(
  color: NeonPhosphorColor,
  settings: Pick<NeonPhosphorSettings, 'enabled' | 'blackFloor' | 'blackFeather'>,
): number {
  if (!settings.enabled ||
      !Number.isFinite(color.r) || !Number.isFinite(color.g) || !Number.isFinite(color.b)) {
    return 0;
  }
  const strongest = Math.max(0, color.r, color.g, color.b);
  const lower = Math.max(0, settings.blackFloor);
  const width = Math.max(Number.EPSILON, settings.blackFeather);
  const transition = Math.max(0, Math.min(1, (strongest - lower) / width));
  return transition * transition * (3 - 2 * transition);
}

/** Strong real edges receive exactly zero ordered dithering or CRT pattern. */
export function phosphorEdgeProtection(minimumLuminance: number, maximumLuminance: number): number {
  if (!Number.isFinite(minimumLuminance) || !Number.isFinite(maximumLuminance)) return 0;
  const minimum = Math.max(0, Math.min(minimumLuminance, maximumLuminance));
  const maximum = Math.max(minimum, maximumLuminance, minimumLuminance);
  const range = maximum - minimum;
  const relative = range / Math.max(maximum, PHOSPHOR_EDGE_LIMITS.luminanceFloor);
  const smooth = (start: number, end: number, value: number): number => {
    const amount = Math.max(0, Math.min(1, (value - start) / (end - start)));
    return amount * amount * (3 - 2 * amount);
  };
  const absoluteEdge = smooth(PHOSPHOR_EDGE_LIMITS.absoluteStart, PHOSPHOR_EDGE_LIMITS.absoluteFull, range);
  const relativeEdge = smooth(PHOSPHOR_EDGE_LIMITS.relativeStart, PHOSPHOR_EDGE_LIMITS.relativeFull, relative) *
    smooth(PHOSPHOR_EDGE_LIMITS.detailStart, PHOSPHOR_EDGE_LIMITS.detailFull, range);
  return 1 - Math.max(absoluteEdge, relativeEdge);
}

/**
 * CPU mirror for the presentation treatment. Quantizing one luminance scalar
 * preserves genuine cyan, magenta, amber, and stellar RGB channel ratios.
 */
export function quantizePhosphorLuminance(
  color: NeonPhosphorColor,
  threshold: number,
  settings: NeonPhosphorSettings,
  edgeProtection = 1,
): NeonPhosphorColor {
  const original = { r: color.r, g: color.g, b: color.b };
  const presence = phosphorPresenceWeight(color, settings);
  const coverage = Number.isFinite(edgeProtection) ? Math.max(0, Math.min(1, edgeProtection)) : 0;
  if (presence === 0 || settings.intensity <= 0 || coverage === 0) return original;

  const luminance = Math.max(0, color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722);
  if (luminance <= Number.EPSILON) return original;

  const levels = Math.max(2, Math.round(settings.paletteLevels));
  const orderedThreshold = Number.isFinite(threshold)
    ? Math.max(-0.5, Math.min(0.5, threshold))
    : 0;
  const ditheredLuminance = Math.max(
    0,
    luminance + orderedThreshold * settings.ditherStrength / levels,
  );
  const quantized = Math.round(ditheredLuminance * levels) / levels;
  const strongest = Math.max(color.r, color.g, color.b);
  const highlight = Math.max(0, Math.min(1, (strongest - 0.58) / 0.42));
  const highlightWeight = highlight * highlight * (3 - 2 * highlight);
  const strength = Math.max(0, Math.min(
    1,
    settings.intensity * presence * (1 - highlightWeight * settings.highlightProtection) * coverage,
  ));
  const presentedLuminance = luminance + (quantized - luminance) * strength;
  const scale = Math.max(0, presentedLuminance / luminance);
  return {
    r: color.r * scale,
    g: color.g * scale,
    b: color.b * scale,
  };
}
