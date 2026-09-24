/** The physical wave field is unchanged; only unresolved render detail is filtered. */
export const SURFACE_OCEAN_WAVELENGTHS_METERS = Object.freeze([440, 185, 70] as const);

/** Fade before the two-samples-per-cycle limit instead of displaying an alias. */
export const SURFACE_OCEAN_BAND_FILTER = Object.freeze({
  fullBelowCyclesPerSample: 0.25,
  hiddenAboveCyclesPerSample: 0.5,
  fullBelowPhaseRadians: Math.PI / 2,
  hiddenAbovePhaseRadians: Math.PI,
} as const);
const ALL_WAVE_BANDS = Object.freeze([1, 1, 1] as const);
const NO_WAVE_BANDS = Object.freeze([0, 0, 0] as const);

export function surfaceOceanBandVisibility(wavelengthMeters: number, footprintMeters: number): number {
  if (!Number.isFinite(wavelengthMeters) || wavelengthMeters <= 0) return 0;
  if (!Number.isFinite(footprintMeters)) return footprintMeters === Number.POSITIVE_INFINITY ? 0 : 1;
  const cycles = Math.max(0, footprintMeters) / wavelengthMeters;
  const policy = SURFACE_OCEAN_BAND_FILTER;
  const t = Math.max(0, Math.min(1, (cycles - policy.fullBelowCyclesPerSample) /
    (policy.hiddenAboveCyclesPerSample - policy.fullBelowCyclesPerSample)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Bound the phase step on both square-grid sampling axes. Their maximum
 * projected spacing is one cell (the diagonal is not an independent sample
 * axis). Near grids can retain the 440 m swell while filtering shorter waves.
 */
export function surfaceOceanGeometryBandWeights(cellMeters: number): readonly [number, number, number] {
  const footprint = Math.max(0, Number.isFinite(cellMeters) ? cellMeters : Infinity);
  if (footprint <= SURFACE_OCEAN_WAVELENGTHS_METERS[2] * SURFACE_OCEAN_BAND_FILTER.fullBelowCyclesPerSample) {
    return ALL_WAVE_BANDS;
  }
  if (footprint >= SURFACE_OCEAN_WAVELENGTHS_METERS[0] * SURFACE_OCEAN_BAND_FILTER.hiddenAboveCyclesPerSample) {
    return NO_WAVE_BANDS;
  }
  return [
    surfaceOceanBandVisibility(SURFACE_OCEAN_WAVELENGTHS_METERS[0], footprint),
    surfaceOceanBandVisibility(SURFACE_OCEAN_WAVELENGTHS_METERS[1], footprint),
    surfaceOceanBandVisibility(SURFACE_OCEAN_WAVELENGTHS_METERS[2], footprint),
  ];
}
