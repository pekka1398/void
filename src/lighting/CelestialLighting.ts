import {
  AU_METERS,
  dotVec3,
  lengthVec3,
  SOLAR_LUMINOSITY_WATTS,
  subVec3,
  type Vec3,
} from '../core';
import type { BodyPose, PlanetDescriptor, StarDescriptor, SystemSnapshot } from '../universe';

export const MAX_CELESTIAL_LIGHT_SOURCES = 3;

export interface SpectralRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface CelestialLightSource {
  readonly slot: 0 | 1 | 2;
  readonly active: boolean;
  readonly id?: string;
  /** Unit direction from the authoritative observer toward this real star. */
  readonly directionWorld: Vec3;
  readonly distanceMeters: number;
  readonly angularRadiusRadians: number;
  readonly colorHex?: string;
  /** Descriptor spectral color in linear RGB. */
  readonly spectralColor: SpectralRgb;
  /** Physical bolometric irradiance relative to the Sun at one AU. */
  readonly irradianceSolar: number;
  readonly irradianceWattsPerSquareMeter: number;
  /** Physical relative irradiance after horizon, eclipse, and atmosphere. */
  readonly receivedIrradianceSolar: number;
  readonly solarElevationRadians: number;
  readonly horizonVisibility: number;
  readonly atmosphericTransmittance: SpectralRgb;
  /** One means unobstructed; zero means total physical eclipse. */
  readonly eclipseVisibility: number;
  readonly eclipseOcclusion: number;
  readonly occluderId?: string;
  /** Finite stellar-disc horizon visibility multiplied by eclipse visibility. */
  readonly visibility: number;
}

export type CelestialLightSlots = readonly [
  CelestialLightSource,
  CelestialLightSource,
  CelestialLightSource,
];

export interface CelestialLightFrame {
  readonly systemId: string;
  readonly timeSeconds: number;
  readonly observerPositionMeters: Vec3;
  readonly observerBodyId?: string;
  readonly atmosphereDensity: number;
  /** Exactly three descriptor-ordered slots; inactive slots never invent IDs. */
  readonly sources: CelestialLightSlots;
  /** Same stable tuple reference, for slot-oriented renderer consumers. */
  readonly slots: CelestialLightSlots;
  readonly sourceCount: number;
  /** Zero-based stable descriptor slot, or -1 when no real star contributes. */
  readonly dominantSlot: number;
  readonly daylight: number;
  readonly twilight: number;
  readonly night: number;
  readonly maxSolarElevationRadians: number;
  readonly totalIrradianceSolar: number;
}

export type CelestialLightingFrame = CelestialLightFrame;

export interface CelestialLightingObserver {
  readonly positionMeters: Vec3;
  readonly body?: PlanetDescriptor;
  readonly bodyPose?: BodyPose;
  readonly surfaceNormalWorld?: Vec3;
  readonly atmosphereDensity?: number;
  readonly atmosphericHumidity?: number;
  readonly includeEclipses?: boolean;
}

interface CelestialOccluder {
  readonly id: string;
  readonly positionMeters: Vec3;
  readonly radiusMeters: number;
}

interface EclipseResult {
  readonly visibility: number;
  readonly occluderId?: string;
}

const ZERO_VECTOR: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });
const BLACK: SpectralRgb = Object.freeze({ r: 0, g: 0, b: 0 });
const CLEAR: SpectralRgb = Object.freeze({ r: 1, g: 1, b: 1 });
const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;
const RADIANS_PER_DEGREE = Math.PI / 180;
const SOLAR_CONSTANT_WATTS = SOLAR_LUMINOSITY_WATTS / (4 * Math.PI * AU_METERS ** 2);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  const progress = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function linearComponent(component: number): number {
  return component <= 0.04045
    ? component / 12.92
    : ((component + 0.055) / 1.055) ** 2.4;
}

function linearSpectralColor(hex: string): SpectralRgb {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  const expanded = normalized.length === 3
    ? normalized.split('').map((digit) => digit + digit).join('')
    : normalized;
  if (!/^[\da-f]{6}$/i.test(expanded)) return CLEAR;
  return {
    r: linearComponent(Number.parseInt(expanded.slice(0, 2), 16) / 255),
    g: linearComponent(Number.parseInt(expanded.slice(2, 4), 16) / 255),
    b: linearComponent(Number.parseInt(expanded.slice(4, 6), 16) / 255),
  };
}

/** Fraction of a uniformly bright, finite circular photosphere above a horizon. */
function visibleDiscFraction(centerElevation: number, angularRadius: number): number {
  if (angularRadius <= 0) return centerElevation >= 0 ? 1 : 0;
  const fraction = centerElevation / angularRadius;
  if (fraction <= -1) return 0;
  if (fraction >= 1) return 1;
  return clamp(
    0.5 + (Math.asin(fraction) + fraction * Math.sqrt(Math.max(0, 1 - fraction * fraction))) / Math.PI,
    0,
    1,
  );
}

/** Angular overlap of an actual opaque sphere and the star's finite projected disc. */
function occludedDiscFraction(starRadius: number, blockerRadius: number, separation: number): number {
  if (starRadius <= 0 || blockerRadius <= 0 || separation >= starRadius + blockerRadius) return 0;
  if (separation <= Math.abs(blockerRadius - starRadius)) {
    return blockerRadius >= starRadius ? 1 : blockerRadius ** 2 / starRadius ** 2;
  }

  const starSquare = starRadius * starRadius;
  const blockerSquare = blockerRadius * blockerRadius;
  const distanceSquare = separation * separation;
  const first = starSquare * Math.acos(clamp(
    (distanceSquare + starSquare - blockerSquare) / (2 * separation * starRadius),
    -1,
    1,
  ));
  const second = blockerSquare * Math.acos(clamp(
    (distanceSquare + blockerSquare - starSquare) / (2 * separation * blockerRadius),
    -1,
    1,
  ));
  const triangle = Math.sqrt(Math.max(0,
    (-separation + starRadius + blockerRadius) *
    (separation + starRadius - blockerRadius) *
    (separation - starRadius + blockerRadius) *
    (separation + starRadius + blockerRadius),
  )) / 2;
  return clamp((first + second - triangle) / (Math.PI * starSquare), 0, 1);
}

function collectOccluders(snapshot: SystemSnapshot): CelestialOccluder[] {
  const occluders: CelestialOccluder[] = [];
  for (const planet of snapshot.system.planets) {
    for (const descriptor of [planet, ...planet.moons]) {
      const pose = snapshot.poses.get(descriptor.id);
      if (!pose || !(descriptor.radiusMeters > 0)) continue;
      occluders.push({
        id: descriptor.id,
        positionMeters: pose.localPositionMeters,
        radiusMeters: descriptor.radiusMeters,
      });
    }
  }
  for (const descriptor of snapshot.system.stars) {
    const pose = snapshot.poses.get(descriptor.id);
    if (!pose || !(descriptor.radiusMeters > 0)) continue;
    occluders.push({
      id: descriptor.id,
      positionMeters: pose.localPositionMeters,
      radiusMeters: descriptor.radiusMeters,
    });
  }
  return occluders;
}

function evaluateEclipse(
  observerPosition: Vec3,
  starId: string,
  starDirection: Vec3,
  starDistance: number,
  starAngularRadius: number,
  observerBodyId: string | undefined,
  occluders: readonly CelestialOccluder[],
): EclipseResult {
  let visibility = 1;
  let strongestOcclusion = 0;
  let occluderId: string | undefined;

  for (const blocker of occluders) {
    if (blocker.id === starId || blocker.id === observerBodyId) continue;
    const offset = subVec3(blocker.positionMeters, observerPosition);
    const distance = lengthVec3(offset);
    if (distance <= blocker.radiusMeters || distance >= starDistance) continue;

    const projection = dotVec3(offset, starDirection);
    if (projection <= 0 || projection >= starDistance) continue;

    const blockerDirection: Vec3 = {
      x: offset.x / distance,
      y: offset.y / distance,
      z: offset.z / distance,
    };
    const separation = Math.acos(clamp(dotVec3(blockerDirection, starDirection), -1, 1));
    const blockerAngularRadius = Math.asin(clamp(blocker.radiusMeters / distance, 0, 1));
    if (separation >= starAngularRadius + blockerAngularRadius) continue;

    const occlusion = occludedDiscFraction(starAngularRadius, blockerAngularRadius, separation);
    visibility *= 1 - occlusion;
    if (occlusion > strongestOcclusion) {
      strongestOcclusion = occlusion;
      occluderId = blocker.id;
    }
    if (visibility <= 1e-7) return { visibility: 0, ...(occluderId ? { occluderId } : {}) };
  }

  return { visibility: clamp(visibility, 0, 1), ...(occluderId ? { occluderId } : {}) };
}

function atmosphericTransmission(
  elevationRadians: number,
  density: number,
  humidity: number,
): SpectralRgb {
  if (density <= 0) return CLEAR;
  const elevationDegrees = clamp(elevationRadians / RADIANS_PER_DEGREE, -4.9, 90);
  // Kasten-Young air mass remains finite at a genuine spherical horizon.
  const airMass = clamp(
    1 / (Math.sin(elevationDegrees * RADIANS_PER_DEGREE) +
      0.50572 * (elevationDegrees + 6.07995) ** -1.6364),
    1,
    40,
  );
  const column = airMass * density;
  const mie = 0.018 * (1 + humidity * 1.65);
  return {
    r: Math.exp(-column * (0.035 + mie)),
    g: Math.exp(-column * (0.082 + mie)),
    b: Math.exp(-column * (0.19 + mie)),
  };
}

function spectralTransmission(color: SpectralRgb, transmission: SpectralRgb): number {
  const luminance = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  if (luminance <= 0) return (transmission.r + transmission.g + transmission.b) / 3;
  return clamp(
    (color.r * transmission.r * 0.2126 +
      color.g * transmission.g * 0.7152 +
      color.b * transmission.b * 0.0722) / luminance,
    0,
    1,
  );
}

function emptySource(slot: 0 | 1 | 2): CelestialLightSource {
  return {
    slot,
    active: false,
    directionWorld: ZERO_VECTOR,
    distanceMeters: Number.POSITIVE_INFINITY,
    angularRadiusRadians: 0,
    spectralColor: BLACK,
    irradianceSolar: 0,
    irradianceWattsPerSquareMeter: 0,
    receivedIrradianceSolar: 0,
    solarElevationRadians: -HALF_PI,
    horizonVisibility: 0,
    atmosphericTransmittance: CLEAR,
    eclipseVisibility: 0,
    eclipseOcclusion: 0,
    visibility: 0,
  };
}

function evaluateSource(
  slot: 0 | 1 | 2,
  descriptor: StarDescriptor,
  pose: BodyPose,
  observer: CelestialLightingObserver,
  surfaceNormal: Vec3 | undefined,
  horizonDrop: number,
  atmosphereDensity: number,
  humidity: number,
  occluders: readonly CelestialOccluder[],
): CelestialLightSource {
  const displacement = subVec3(pose.localPositionMeters, observer.positionMeters);
  const actualDistance = lengthVec3(displacement);
  if (!(actualDistance > 0)) return emptySource(slot);

  const directionWorld: Vec3 = {
    x: displacement.x / actualDistance,
    y: displacement.y / actualDistance,
    z: displacement.z / actualDistance,
  };
  const distanceMeters = Math.max(descriptor.radiusMeters, actualDistance);
  const angularRadiusRadians = Math.asin(clamp(descriptor.radiusMeters / distanceMeters, 0, 1));
  const irradianceSolar = Math.max(0, descriptor.luminositySolar) /
    Math.max((distanceMeters / AU_METERS) ** 2, Number.MIN_VALUE);
  const spectralColor = linearSpectralColor(descriptor.color);
  const solarElevationRadians = surfaceNormal
    ? Math.asin(clamp(dotVec3(surfaceNormal, directionWorld), -1, 1))
    : HALF_PI;
  const horizonVisibility = surfaceNormal
    ? visibleDiscFraction(solarElevationRadians + horizonDrop, angularRadiusRadians)
    : 1;
  const atmosphericTransmittance = atmosphericTransmission(
    solarElevationRadians + horizonDrop,
    atmosphereDensity,
    humidity,
  );
  const eclipse = observer.includeEclipses === false
    ? { visibility: 1 }
    : evaluateEclipse(
      observer.positionMeters,
      descriptor.id,
      directionWorld,
      distanceMeters,
      angularRadiusRadians,
      observer.body?.id,
      occluders,
    );
  const eclipseVisibility = eclipse.visibility;
  const visibility = horizonVisibility * eclipseVisibility;
  const receivedIrradianceSolar = irradianceSolar * visibility *
    spectralTransmission(spectralColor, atmosphericTransmittance);

  return {
    slot,
    active: true,
    id: descriptor.id,
    directionWorld,
    distanceMeters: actualDistance,
    angularRadiusRadians,
    colorHex: descriptor.color,
    spectralColor,
    irradianceSolar,
    irradianceWattsPerSquareMeter: irradianceSolar * SOLAR_CONSTANT_WATTS,
    receivedIrradianceSolar,
    solarElevationRadians,
    horizonVisibility,
    atmosphericTransmittance,
    eclipseVisibility,
    eclipseOcclusion: 1 - eclipseVisibility,
    ...(eclipse.occluderId ? { occluderId: eclipse.occluderId } : {}),
    visibility,
  };
}

/**
 * Evaluate every authentic stellar contribution in one coherent observer frame.
 * Slots follow descriptor order and remain stable across binary/triple eclipses.
 */
export function evaluateCelestialLighting(
  snapshot: SystemSnapshot,
  observer: CelestialLightingObserver,
): CelestialLightFrame {
  const atmosphereDensity = clamp(
    Number.isFinite(observer.atmosphereDensity) ? observer.atmosphereDensity! : 0,
    0,
    1,
  );
  const humidity = clamp(
    Number.isFinite(observer.atmosphericHumidity) ? observer.atmosphericHumidity! : 0,
    0,
    1,
  );
  const bodyPose = observer.bodyPose ??
    (observer.body ? snapshot.poses.get(observer.body.id) : undefined);
  const bodyOffset = bodyPose ? subVec3(observer.positionMeters, bodyPose.localPositionMeters) : undefined;
  const bodyDistance = bodyOffset ? lengthVec3(bodyOffset) : 0;
  const suppliedNormalLength = observer.surfaceNormalWorld ? lengthVec3(observer.surfaceNormalWorld) : 0;
  const surfaceNormal: Vec3 | undefined = suppliedNormalLength > 0
    ? {
      x: observer.surfaceNormalWorld!.x / suppliedNormalLength,
      y: observer.surfaceNormalWorld!.y / suppliedNormalLength,
      z: observer.surfaceNormalWorld!.z / suppliedNormalLength,
    }
    : bodyOffset && bodyDistance > 0
      ? {
        x: bodyOffset.x / bodyDistance,
        y: bodyOffset.y / bodyDistance,
        z: bodyOffset.z / bodyDistance,
      }
      : undefined;
  const horizonDrop = observer.body && bodyDistance > observer.body.radiusMeters
    ? Math.acos(clamp(observer.body.radiusMeters / bodyDistance, 0, 1))
    : 0;
  const occluders = observer.includeEclipses === false ? [] : collectOccluders(snapshot);
  const result: CelestialLightSource[] = [];

  for (let index = 0; index < MAX_CELESTIAL_LIGHT_SOURCES; index += 1) {
    const slot = index as 0 | 1 | 2;
    const descriptor = snapshot.system.stars[index];
    const pose = descriptor ? snapshot.poses.get(descriptor.id) : undefined;
    result.push(descriptor && pose
      ? evaluateSource(slot, descriptor, pose, observer, surfaceNormal, horizonDrop,
        atmosphereDensity, humidity, occluders)
      : emptySource(slot));
  }

  const sources = result as unknown as CelestialLightSlots;
  let sourceCount = 0;
  let dominantSlot = -1;
  let dominantIrradiance = 0;
  let totalIrradianceSolar = 0;
  let rawIrradianceSolar = 0;
  let visibleIrradianceSolar = 0;
  let maxSolarElevationRadians = -HALF_PI;

  for (const source of sources) {
    if (!source.active) continue;
    sourceCount += 1;
    totalIrradianceSolar += source.receivedIrradianceSolar;
    rawIrradianceSolar += source.irradianceSolar;
    visibleIrradianceSolar += source.irradianceSolar * source.visibility;
    maxSolarElevationRadians = Math.max(maxSolarElevationRadians, source.solarElevationRadians);
    if (source.receivedIrradianceSolar > dominantIrradiance) {
      dominantIrradiance = source.receivedIrradianceSolar;
      dominantSlot = source.slot;
    }
  }

  const geometricDaylight = sourceCount > 0
    ? smoothstep(-6 * RADIANS_PER_DEGREE, 8 * RADIANS_PER_DEGREE, maxSolarElevationRadians)
    : 0;
  const eclipseAttenuation = rawIrradianceSolar > 0
    ? Math.sqrt(clamp(visibleIrradianceSolar / rawIrradianceSolar, 0, 1))
    : 0;
  const daylight = clamp(geometricDaylight * eclipseAttenuation, 0, 1);
  const naturalTwilight = smoothstep(-18 * RADIANS_PER_DEGREE, -6 * RADIANS_PER_DEGREE,
    maxSolarElevationRadians) *
    (1 - smoothstep(-2 * RADIANS_PER_DEGREE, 8 * RADIANS_PER_DEGREE, maxSolarElevationRadians));
  const eclipseTwilight = (1 - eclipseAttenuation) * geometricDaylight * 0.76;
  const twilight = clamp(Math.max(naturalTwilight, eclipseTwilight), 0, 1 - daylight);
  const night = clamp(1 - daylight - twilight, 0, 1);

  return {
    systemId: snapshot.system.id,
    timeSeconds: snapshot.timeSeconds,
    observerPositionMeters: {
      x: observer.positionMeters.x,
      y: observer.positionMeters.y,
      z: observer.positionMeters.z,
    },
    ...(observer.body ? { observerBodyId: observer.body.id } : {}),
    atmosphereDensity,
    sources,
    slots: sources,
    sourceCount,
    dominantSlot,
    daylight,
    twilight,
    night,
    maxSolarElevationRadians,
    totalIrradianceSolar,
  };
}

/** Stable useful physical scale for diagnostic UI and renderer normalization. */
export { SOLAR_CONSTANT_WATTS };
