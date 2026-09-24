export const AU_METERS = 149_597_870_700;
export const LIGHT_YEAR_METERS = 9_460_730_472_580_800;
export const SPEED_OF_LIGHT = 299_792_458;
export const EARTH_RADIUS_METERS = 6_371_000;
export const EARTH_MASS_KG = 5.9722e24;
export const SOLAR_RADIUS_METERS = 695_700_000;
export const SOLAR_MASS_KG = 1.98847e30;
export const SOLAR_LUMINOSITY_WATTS = 3.828e26;
export const GRAVITATIONAL_CONSTANT = 6.6743e-11;
export const CELL_SIZE_METERS = 1_000_000_000_000;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_YEAR = 31_557_600;

export function metersToAu(meters: number): number {
  return meters / AU_METERS;
}

export function auToMeters(au: number): number {
  return au * AU_METERS;
}

export function metersToLightYears(meters: number): number {
  return meters / LIGHT_YEAR_METERS;
}

export function lightYearsToMeters(lightYears: number): number {
  return lightYears * LIGHT_YEAR_METERS;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  const absolute = Math.abs(meters);
  const sign = meters < 0 ? "−" : "";

  if (absolute >= LIGHT_YEAR_METERS * 0.1) {
    const lightYears = absolute / LIGHT_YEAR_METERS;
    return `${sign}${lightYears.toFixed(lightYears >= 100 ? 1 : 2)} ly`;
  }
  if (absolute >= AU_METERS * 0.01) {
    const astronomicalUnits = absolute / AU_METERS;
    return `${sign}${astronomicalUnits.toFixed(astronomicalUnits >= 10 ? 1 : 2)} AU`;
  }
  if (absolute >= 1_000_000) return `${sign}${(absolute / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} km`;
  if (absolute >= 1_000) return `${sign}${(absolute / 1000).toFixed(1)} km`;
  return `${sign}${absolute.toFixed(absolute < 10 ? 1 : 0)} m`;
}

export function formatSpeed(metersPerSecond: number): string {
  if (!Number.isFinite(metersPerSecond)) return "—";
  const absolute = Math.abs(metersPerSecond);
  if (absolute >= SPEED_OF_LIGHT * 0.1) {
    const multiples = metersPerSecond / SPEED_OF_LIGHT;
    if (Math.abs(multiples) >= 1_000_000) return `${(multiples / 1_000_000).toFixed(1)} Mc`;
    if (Math.abs(multiples) >= 1_000) return `${(multiples / 1_000).toFixed(1)} kc`;
    return `${multiples.toFixed(Math.abs(multiples) >= 10 ? 1 : 2)}c`;
  }
  if (absolute >= 1_000) return `${(metersPerSecond / 1_000).toFixed(absolute >= 100_000 ? 0 : 1)} km/s`;
  return `${metersPerSecond.toFixed(absolute < 10 ? 1 : 0)} m/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < SECONDS_PER_DAY) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds < SECONDS_PER_YEAR) return `${Math.floor(seconds / SECONDS_PER_DAY)}d ${Math.floor((seconds % SECONDS_PER_DAY) / 3600)}h`;
  return `${(seconds / SECONDS_PER_YEAR).toFixed(1)}y`;
}
