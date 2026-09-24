import { AU_METERS, vec3, type Vec3 } from '../../core';
import type { PlanetDescriptor, StarSystem } from '../../universe/types';

const DEFAULT_METERS_PER_RENDER_UNIT = 140_000;
const DEFAULT_CAMERA_FAR_RENDER_UNITS = 120_000_000;
const DEFAULT_MINIMUM_OUTER_RADIUS_AU = 6;
const DEFAULT_MAXIMUM_OUTER_RADIUS_AU = 48;
const REFERENCE_OUTER_RADIUS_RENDER_UNITS = 8_780;
const REFERENCE_INNER_RADIUS_RENDER_UNITS = 7_640;
const ORBITAL_MARGIN_FACTOR = 1.45;
const ORBITAL_PADDING_AU = 0.7;
const CAMERA_FAR_RADIUS_FRACTION = 0.45;

export interface SystemNebulaVolumeOptions {
  readonly metersPerRenderUnit?: number;
  readonly cameraFarRenderUnits?: number;
  readonly minimumOuterRadiusAu?: number;
  readonly maximumOuterRadiusAu?: number;
}

export interface SystemNebulaVolume {
  readonly systemId: string;
  readonly anchorKind: 'system-barycenter';
  readonly anchorMeters: Vec3;
  readonly outermostOrbitMeters: number;
  readonly outerRadiusMeters: number;
  readonly innerRadiusMeters: number;
  readonly outerRadiusAu: number;
  readonly referenceRadiusRenderUnits: 8_780;
  readonly renderScale: number;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number`);
  }
  return value;
}

function nonnegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite nonnegative number`);
  }
  return value;
}

function orbitalApocenterMeters(
  orbit: Pick<PlanetDescriptor['orbit'], 'semiMajorAxisMeters' | 'eccentricity'>,
  label: string,
): number {
  const semiMajorAxisMeters = positiveFinite(orbit.semiMajorAxisMeters, `${label} semimajor axis`);
  const eccentricity = nonnegativeFinite(orbit.eccentricity, `${label} eccentricity`);
  if (eccentricity >= 1) throw new RangeError(`${label} eccentricity must be less than one`);
  return semiMajorAxisMeters * (1 + eccentricity);
}

function bodyEnvelopeMeters(planet: PlanetDescriptor): number {
  const radiusMeters = positiveFinite(planet.radiusMeters, `${planet.id} radius`);
  const atmosphereHeightMeters = nonnegativeFinite(planet.atmosphere.heightMeters, `${planet.id} atmosphere height`);
  let envelopeMeters = radiusMeters + atmosphereHeightMeters;

  if (planet.ring) {
    envelopeMeters = Math.max(
      envelopeMeters,
      positiveFinite(planet.ring.outerRadiusMeters, `${planet.id} ring outer radius`),
    );
  }

  if (!Array.isArray(planet.moons)) throw new TypeError(`${planet.id} moons must be an array`);
  for (const moon of planet.moons) {
    const moonRadiusMeters = positiveFinite(moon.radiusMeters, `${moon.id} radius`);
    const moonApocenterMeters = orbitalApocenterMeters(moon.orbit, moon.id);
    envelopeMeters = Math.max(envelopeMeters, moonApocenterMeters + moonRadiusMeters);
  }

  return envelopeMeters;
}

/**
 * Bounds existing seeded gas around the real system barycenter, never around a
 * planet, camera, saved epoch, or invented celestial object. Existing render
 * coordinates remain untouched: callers apply renderScale to their seeded gas
 * mesh and continue subtracting the real camera position from anchorMeters.
 */
export function deriveSystemNebulaVolume(
  system: StarSystem,
  options: SystemNebulaVolumeOptions = {},
): SystemNebulaVolume {
  if (!system || typeof system.id !== 'string' || system.id.length === 0) {
    throw new TypeError('A nebula volume requires a real star-system identifier');
  }
  if (!Array.isArray(system.stars) || system.stars.length === 0) {
    throw new TypeError(`${system.id} must contain at least one real star`);
  }
  if (!Array.isArray(system.planets)) throw new TypeError(`${system.id} planets must be an array`);

  const metersPerRenderUnit = positiveFinite(
    options.metersPerRenderUnit ?? DEFAULT_METERS_PER_RENDER_UNIT,
    'Meters per render unit',
  );
  const cameraFarRenderUnits = positiveFinite(
    options.cameraFarRenderUnits ?? DEFAULT_CAMERA_FAR_RENDER_UNITS,
    'Camera far distance',
  );
  const minimumOuterRadiusAu = positiveFinite(
    options.minimumOuterRadiusAu ?? DEFAULT_MINIMUM_OUTER_RADIUS_AU,
    'Minimum nebula radius',
  );
  const maximumOuterRadiusAu = positiveFinite(
    options.maximumOuterRadiusAu ?? DEFAULT_MAXIMUM_OUTER_RADIUS_AU,
    'Maximum nebula radius',
  );
  if (minimumOuterRadiusAu > maximumOuterRadiusAu) {
    throw new RangeError('Minimum nebula radius cannot exceed its maximum radius');
  }

  const binarySeparationMeters = system.binarySeparationMeters === undefined
    ? 0
    : nonnegativeFinite(system.binarySeparationMeters, `${system.id} binary separation`);
  const outerSeparationMeters = system.outerSeparationMeters === undefined
    ? 0
    : nonnegativeFinite(system.outerSeparationMeters, `${system.id} outer stellar separation`);
  let stellarCenterReachMeters = binarySeparationMeters + outerSeparationMeters;
  let largestStarRadiusMeters = 0;
  for (const star of system.stars) {
    largestStarRadiusMeters = Math.max(
      largestStarRadiusMeters,
      positiveFinite(star.radiusMeters, `${star.id} radius`),
    );
    if (star.orbit) {
      stellarCenterReachMeters = Math.max(
        stellarCenterReachMeters,
        orbitalApocenterMeters(star.orbit, star.id),
      );
    }
  }

  let outermostOrbitMeters = 0;
  let physicalEnvelopeMeters = stellarCenterReachMeters + largestStarRadiusMeters;
  for (const planet of system.planets) {
    const orbitRadiusMeters = positiveFinite(planet.orbit.semiMajorAxisMeters, `${planet.id} semimajor axis`);
    outermostOrbitMeters = Math.max(outermostOrbitMeters, orbitRadiusMeters);
    const orbitCenterReachMeters = planet.orbit.parentId === system.id ? 0 : stellarCenterReachMeters;
    physicalEnvelopeMeters = Math.max(
      physicalEnvelopeMeters,
      orbitCenterReachMeters + orbitalApocenterMeters(planet.orbit, planet.id) + bodyEnvelopeMeters(planet),
    );
  }

  const minimumOuterRadiusMeters = minimumOuterRadiusAu * AU_METERS;
  // Leave room for an observer near the opposite edge of the same real system;
  // a shell merely smaller than the camera's far plane can still be clipped.
  const maximumOuterRadiusMeters = Math.min(
    maximumOuterRadiusAu * AU_METERS,
    cameraFarRenderUnits * metersPerRenderUnit * CAMERA_FAR_RADIUS_FRACTION,
  );
  if (maximumOuterRadiusMeters < minimumOuterRadiusMeters) {
    throw new RangeError('The camera far plane cannot contain the minimum nebula volume');
  }

  const outerRadiusMeters = Math.min(
    maximumOuterRadiusMeters,
    Math.max(
      minimumOuterRadiusMeters,
      physicalEnvelopeMeters * ORBITAL_MARGIN_FACTOR + ORBITAL_PADDING_AU * AU_METERS,
    ),
  );
  const innerRadiusMeters = outerRadiusMeters *
    REFERENCE_INNER_RADIUS_RENDER_UNITS / REFERENCE_OUTER_RADIUS_RENDER_UNITS;

  return {
    systemId: system.id,
    anchorKind: 'system-barycenter',
    anchorMeters: vec3(),
    outermostOrbitMeters,
    outerRadiusMeters,
    innerRadiusMeters,
    outerRadiusAu: outerRadiusMeters / AU_METERS,
    referenceRadiusRenderUnits: REFERENCE_OUTER_RADIUS_RENDER_UNITS,
    renderScale: outerRadiusMeters / (REFERENCE_OUTER_RADIUS_RENDER_UNITS * metersPerRenderUnit),
  };
}
