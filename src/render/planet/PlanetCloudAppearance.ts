import type { PlanetCloudType } from '../../universe';

export interface PlanetCloudAppearance {
  readonly tint: string;
  readonly tintStrength: number;
  readonly verticalScale: number;
}

// One small art-directed palette for both orbital and local formations.
// Ordinary water clouds retain Aurelia's accepted colors and silhouette.
const APPEARANCE: Readonly<Record<PlanetCloudType, PlanetCloudAppearance>> = Object.freeze({
  none: Object.freeze({ tint: '#FFFFFF', tintStrength: 0, verticalScale: 0 }),
  water: Object.freeze({ tint: '#FFFFFF', tintStrength: 0, verticalScale: 1 }),
  'water-ice': Object.freeze({ tint: '#C1E1FF', tintStrength: 0.28, verticalScale: 0.52 }),
  methane: Object.freeze({ tint: '#D8B484', tintStrength: 0.3, verticalScale: 0.68 }),
  'volcanic-aerosol': Object.freeze({ tint: '#9C829B', tintStrength: 0.32, verticalScale: 0.72 }),
  ammonia: Object.freeze({ tint: '#DED6C4', tintStrength: 0.18, verticalScale: 0.84 }),
});

export function planetCloudAppearance(cloudType: PlanetCloudType): PlanetCloudAppearance {
  return APPEARANCE[cloudType];
}
