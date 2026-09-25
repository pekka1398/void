import { AU_METERS, SECONDS_PER_DAY } from '../orbit';

export function formatDistance(meters: number): string {
  if (meters === Number.POSITIVE_INFINITY) return '∞';
  if (!Number.isFinite(meters)) throw new RangeError(`formatDistance(${meters})`);
  const a = Math.abs(meters);
  if (a >= 0.01 * AU_METERS) return `${(meters / AU_METERS).toFixed(4)} AU`;
  if (a >= 1e4) return `${(meters / 1000).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;
  return `${meters.toFixed(1)} m`;
}

export function formatSpeed(metersPerSecond: number): string {
  if (!Number.isFinite(metersPerSecond)) throw new RangeError(`formatSpeed(${metersPerSecond})`);
  return Math.abs(metersPerSecond) >= 1e4
    ? `${(metersPerSecond / 1000).toFixed(3)} km/s`
    : `${metersPerSecond.toFixed(2)} m/s`;
}

export function formatDuration(seconds: number): string {
  if (seconds === Number.POSITIVE_INFINITY) return '∞';
  if (!Number.isFinite(seconds)) throw new RangeError(`formatDuration(${seconds})`);
  const sign = seconds < 0 ? '−' : '';
  let s = Math.abs(seconds);
  const days = Math.floor(s / SECONDS_PER_DAY);
  s -= days * SECONDS_PER_DAY;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const clock = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(0).padStart(2, '0')}`;
  return days > 0 ? `${sign}${days}d ${clock}` : `${sign}${clock}`;
}

export function formatWarp(warp: number): string {
  return warp >= 1000 ? `${warp.toExponential(0).replace('e+', 'e')}×` : `${warp}×`;
}
