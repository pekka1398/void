import { samplePlanetClimate, type PlanetArchetype, type PlanetField } from './PlanetField';
import { hashUnit, ridgeNoise3, valueNoise3, type Vec3Like } from './noise';

export type PlanetGeologyFeatureKind =
  | 'mountain-belt'
  | 'ridge'
  | 'plateau'
  | 'impact-basin'
  | 'caldera'
  | 'canyon';

export interface PlanetGeologyFeature {
  readonly id: string;
  readonly kind: PlanetGeologyFeatureKind;
  /** Persistent unit direction in the rotating planet's own coordinate frame. */
  readonly centerDirection: Vec3Like;
  /** Unit tangent describing the connected belt, ridge, or canyon heading. */
  readonly axisDirection: Vec3Like;
  readonly lengthMeters: number;
  readonly widthMeters: number;
  readonly radiusMeters: number;
  /** Positive physical magnitude; impact basins/canyons apply it downward. */
  readonly reliefMeters: number;
}

export interface PlanetGeologyProfile {
  readonly seed: number;
  readonly generatorVersion: number;
  readonly archetype: PlanetArchetype;
  readonly radiusMeters: number;
  readonly maxHeightMeters: number;
  readonly features: readonly PlanetGeologyFeature[];
}

export interface PlanetGeologySample {
  /** Signed real topography before the shared field applies its shoreline gate. */
  readonly heightOffsetMeters: number;
  readonly mountainStrength: number;
  readonly ridgeStrength: number;
  readonly plateauStrength: number;
  readonly basinStrength: number;
  readonly craterStrength: number;
  readonly canyonStrength: number;
  readonly dominantFeatureId: string | null;
  readonly dominantFeatureDirection: Vec3Like | null;
}

type PlanetGeologyField = PlanetField;

interface GeologicalPlacement {
  readonly direction: Vec3Like;
  readonly heightMeters: number;
  readonly ocean: boolean;
  readonly index: number;
}

const PROFILE_CACHE_LIMIT = 96;
const profiles = new Map<string, PlanetGeologyProfile>();

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothRange(start: number, end: number, value: number): number {
  const blend = clamp((value - start) / Math.max(Number.EPSILON, end - start));
  return blend * blend * (3 - 2 * blend);
}

function dot(first: Vec3Like, second: Vec3Like): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function normalize(direction: Vec3Like): Vec3Like {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < Number.EPSILON) return { x: 0, y: 1, z: 0 };
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

function cross(first: Vec3Like, second: Vec3Like): Vec3Like {
  return {
    x: first.y * second.z - first.z * second.y,
    y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x,
  };
}

function seededUnit(seed: number, salt: number): number {
  return hashUnit(seed ^ Math.imul(salt + 1, 0x9e37_79b9));
}

function seededDirection(seed: number, index: number): Vec3Like {
  const vertical = seededUnit(seed, index * 3 + 1) * 2 - 1;
  const azimuth = seededUnit(seed, index * 3 + 2) * Math.PI * 2;
  const planar = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  return { x: Math.cos(azimuth) * planar, y: vertical, z: Math.sin(azimuth) * planar };
}

function tangentFor(direction: Vec3Like, seed: number, index: number): Vec3Like {
  const reference = Math.abs(direction.y) < 0.88
    ? { x: 0, y: 1, z: 0 }
    : { x: 1, y: 0, z: 0 };
  const first = normalize(cross(reference, direction));
  const second = cross(direction, first);
  const angle = seededUnit(seed, index * 3 + 3) * Math.PI * 2;
  return normalize({
    x: first.x * Math.cos(angle) + second.x * Math.sin(angle),
    y: first.y * Math.cos(angle) + second.y * Math.sin(angle),
    z: first.z * Math.cos(angle) + second.z * Math.sin(angle),
  });
}

function archetypeRelief(archetype: PlanetArchetype): number {
  if (archetype === 'volcanic') return 1.24;
  if (archetype === 'frozen' || archetype === 'ice-moon') return 1.11;
  if (archetype === 'temperate') return 1.05;
  if (archetype === 'desert') return 0.85;
  if (archetype === 'barren') return 0.94;
  return 1;
}

function feature(
  field: PlanetGeologyField,
  kind: PlanetGeologyFeatureKind,
  index: number,
  centerDirection: Vec3Like,
): PlanetGeologyFeature {
  const seed = field.seed ^ 0x62e3_91a7;
  const axisDirection = tangentFor(centerDirection, seed, index);
  const shape = seededUnit(seed, index * 7 + 4);
  const variation = seededUnit(seed, index * 7 + 5);
  const scale = clamp(field.radiusMeters / 6_371_000, 0.42, 1.3);
  const relief = archetypeRelief(field.archetype);

  let lengthMeters = (190_000 + shape * 300_000) * scale;
  let widthMeters = (36_000 + variation * 84_000) * scale;
  let reliefMeters = (1_450 + variation * 1_650) * relief;

  if (kind === 'ridge') {
    lengthMeters = (130_000 + shape * 270_000) * scale;
    widthMeters = (14_000 + variation * 42_000) * scale;
    reliefMeters = (850 + variation * 1_050) * relief;
  } else if (kind === 'plateau') {
    lengthMeters = (90_000 + shape * 230_000) * scale;
    widthMeters = (65_000 + variation * 165_000) * scale;
    reliefMeters = (520 + variation * 950) * relief;
  } else if (kind === 'impact-basin' || kind === 'caldera') {
    widthMeters = (kind === 'caldera' ? 28_000 : 48_000)
      + variation * (kind === 'caldera' ? 82_000 : 168_000);
    widthMeters *= scale;
    lengthMeters = widthMeters;
    reliefMeters = (kind === 'caldera' ? 680 : 410)
      + variation * (kind === 'caldera' ? 1_220 : 940);
    reliefMeters *= relief;
  } else if (kind === 'canyon') {
    lengthMeters = (160_000 + shape * 320_000) * scale;
    widthMeters = (11_000 + variation * 31_000) * scale;
    reliefMeters = (270 + variation * 790) * relief;
  }

  const radiusMeters = Math.max(widthMeters * 0.5, lengthMeters * 0.5);
  return Object.freeze({
    id: `${field.seed.toString(16).padStart(8, '0')}:${kind}:${index}`,
    kind,
    centerDirection: Object.freeze(centerDirection),
    axisDirection: Object.freeze(axisDirection),
    lengthMeters,
    widthMeters,
    radiusMeters,
    reliefMeters: Math.min(field.maxHeightMeters * 0.37, reliefMeters),
  });
}

function actualGeologicalPlacements(field: PlanetGeologyField): GeologicalPlacement[] {
  // Evaluate the actual unchanged legacy field exactly once per deterministic
  // candidate. Version one cannot recurse into macro-geology, and the compact
  // climate sampler deliberately omits expensive river-heading derivatives.
  const legacy = { ...field, generatorVersion: 1 };
  const candidates: GeologicalPlacement[] = [];
  for (let index = 0; index < 128; index += 1) {
    const direction = seededDirection(field.seed ^ 0x714d_a283, index);
    const sample = samplePlanetClimate(legacy, direction);
    candidates.push({ direction, heightMeters: sample.heightMeters, ocean: sample.ocean, index });
  }
  return candidates;
}

function chooseGeologicalPlacement(
  field: PlanetGeologyField,
  kind: PlanetGeologyFeatureKind,
  featureIndex: number,
  candidates: readonly GeologicalPlacement[],
  used: Set<number>,
): Vec3Like {
  const minimumHeight = kind === 'impact-basin' || kind === 'caldera'
    ? 620
    : kind === 'canyon'
      ? 390
      : 170;
  const targetHeight = kind === 'impact-basin' || kind === 'caldera'
    ? 2_100
    : kind === 'canyon'
      ? 1_200
      : kind === 'plateau'
        ? 720
        : 1_150;

  const pick = (allowReused: boolean, requireMinimum: boolean): GeologicalPlacement | undefined => {
    let best: GeologicalPlacement | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.ocean || (!allowReused && used.has(candidate.index))) continue;
      if (candidate.heightMeters < (requireMinimum ? minimumHeight : 121)) continue;
      const geologicalVariation = seededUnit(
        field.seed ^ Math.imul(featureIndex + 1, 0x4e67_c6a7),
        candidate.index,
      ) * 0.9;
      const score = geologicalVariation
        - Math.abs(candidate.heightMeters - targetHeight) / 4_100;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  };

  const chosen = pick(false, true)
    ?? pick(false, false)
    ?? pick(true, true)
    ?? pick(true, false)
    ?? candidates[featureIndex % candidates.length]!;
  used.add(chosen.index);
  return chosen.direction;
}

/** Stable body-fixed tectonic landmarks shared by weather, collision, and renderers. */
export function createPlanetGeologyProfile(field: PlanetGeologyField): PlanetGeologyProfile {
  const key = `${field.seed}:${field.generatorVersion}:${field.archetype}:${field.radiusMeters}:${field.maxHeightMeters}`;
  const cached = profiles.get(key);
  if (cached) return cached;

  const placements = actualGeologicalPlacements(field);
  const usedPlacements = new Set<number>();
  const features: PlanetGeologyFeature[] = [];
  let index = 0;
  const addFeature = (kind: PlanetGeologyFeatureKind) => {
    const center = chooseGeologicalPlacement(field, kind, index, placements, usedPlacements);
    features.push(feature(field, kind, index++, center));
  };
  for (let count = 0; count < 4; count += 1) addFeature('mountain-belt');
  for (let count = 0; count < 3; count += 1) addFeature('ridge');
  for (let count = 0; count < 2; count += 1) addFeature('plateau');

  const basinKind = field.archetype === 'volcanic' ? 'caldera' : 'impact-basin';
  const basinCount = field.archetype === 'frozen'
    || field.archetype === 'ice-moon'
    || field.archetype === 'barren'
    ? 4
    : 3;
  for (let count = 0; count < basinCount; count += 1) addFeature(basinKind);
  for (let count = 0; count < 3; count += 1) addFeature('canyon');

  const profile: PlanetGeologyProfile = Object.freeze({
    seed: field.seed,
    generatorVersion: field.generatorVersion,
    archetype: field.archetype,
    radiusMeters: field.radiusMeters,
    maxHeightMeters: field.maxHeightMeters,
    features: Object.freeze(features),
  });

  if (profiles.size >= PROFILE_CACHE_LIMIT) {
    const oldest = profiles.keys().next().value;
    if (oldest !== undefined) profiles.delete(oldest);
  }
  profiles.set(key, profile);
  return profile;
}

/** Continuous face-independent 10–500 km tectonic folds and signed physical basins. */
export function samplePlanetGeology(
  profile: PlanetGeologyProfile,
  rawDirection: Vec3Like,
): PlanetGeologySample {
  const direction = normalize(rawDirection);
  const firstBelt = profile.features[0]!;
  const secondBelt = profile.features[1]!;
  const crossBelt = cross(firstBelt.centerDirection, firstBelt.axisDirection);
  const crossSecond = cross(secondBelt.centerDirection, secondBelt.axisDirection);
  const reliefScale = archetypeRelief(profile.archetype);
  const foldedFrequency = clamp(profile.radiusMeters / 185_000, 9, 44);

  // Stretch each noise domain along a real, stable tectonic heading. The same
  // fold therefore runs for hundreds of kilometers rather than creating
  // isolated high-frequency bumps or cube-face-aligned seams.
  const longFoldDirection = {
    x: dot(direction, firstBelt.axisDirection) * 0.24,
    y: dot(direction, crossBelt) * 1.08,
    z: dot(direction, firstBelt.centerDirection) * 0.68,
  };
  const crossingFoldDirection = {
    x: dot(direction, secondBelt.axisDirection) * 0.35,
    y: dot(direction, crossSecond) * 0.92,
    z: dot(direction, secondBelt.centerDirection) * 0.62,
  };
  const foldedRange = ridgeNoise3(longFoldDirection, {
    frequency: foldedFrequency,
    octaves: 2,
    persistence: 0.48,
    seed: profile.seed ^ 0x18bf_744d,
  });
  const crossingRange = ridgeNoise3(crossingFoldDirection, {
    frequency: foldedFrequency * 0.62,
    octaves: 1,
    seed: profile.seed ^ 0xa873_56e1,
  });
  const province = (valueNoise3(
    direction.x * 3.7,
    direction.y * 3.7,
    direction.z * 3.7,
    profile.seed ^ 0x3db1_0f67,
  ) + 1) * 0.5;
  const upliftProvince = smoothRange(0.24, 0.77, province);
  let mountainStrength = smoothRange(0.34, 0.83, foldedRange)
    * (0.42 + upliftProvince * 0.58);
  let ridgeStrength = smoothRange(0.36, 0.87, crossingRange)
    * (0.4 + upliftProvince * 0.6);
  let plateauStrength = smoothRange(0.64, 0.88, province)
    * (0.5 + smoothRange(0.31, 0.66, crossingRange) * 0.5);

  const corridor = valueNoise3(
    longFoldDirection.x * foldedFrequency * 0.31,
    longFoldDirection.y * foldedFrequency * 1.08,
    longFoldDirection.z * foldedFrequency * 0.76,
    profile.seed ^ 0x551e_c893,
  );
  let canyonStrength = (1 - smoothRange(0.055, 0.2, Math.abs(corridor)))
    * (0.27 + upliftProvince * 0.56);
  let basinStrength = 0;
  let craterStrength = 0;

  let upliftMeters = (
    mountainStrength * mountainStrength * 3_050
    + ridgeStrength * 920
    + plateauStrength * 780
  ) * reliefScale;
  let depressionMeters = canyonStrength * (profile.archetype === 'desert' ? 660 : 430);
  let strongestFeature = Math.max(mountainStrength, ridgeStrength);
  let dominantFeature: PlanetGeologyFeature | null = mountainStrength >= ridgeStrength
    ? firstBelt
    : secondBelt;

  for (const landmark of profile.features) {
    const centerAlignment = dot(direction, landmark.centerDirection);
    const outerAngle = landmark.radiusMeters * 1.4 / profile.radiusMeters;
    if (centerAlignment < 1 - outerAngle * outerAngle * 0.52) continue;

    const transverse = cross(landmark.centerDirection, landmark.axisDirection);
    const alongMeters = dot(direction, landmark.axisDirection) * profile.radiusMeters;
    const acrossMeters = dot(direction, transverse) * profile.radiusMeters;
    const along = alongMeters / Math.max(1, landmark.lengthMeters * 0.5);
    const across = acrossMeters / Math.max(1, landmark.widthMeters * 0.5);
    const distance = Math.hypot(along, across);
    if (distance > 1.28) continue;

    let strength = 1 - smoothRange(0.28, 1.14, distance);
    if (landmark.kind === 'mountain-belt') {
      const connectedCrest = 0.9 + ridgeStrength * 0.1;
      strength *= connectedCrest;
      mountainStrength = Math.max(mountainStrength, strength);
      upliftMeters += landmark.reliefMeters * strength;
    } else if (landmark.kind === 'ridge') {
      strength = Math.pow(strength, 0.82);
      ridgeStrength = Math.max(ridgeStrength, strength);
      upliftMeters += landmark.reliefMeters * strength;
    } else if (landmark.kind === 'plateau') {
      strength = 1 - smoothRange(0.64, 1.09, distance);
      plateauStrength = Math.max(plateauStrength, strength);
      upliftMeters += landmark.reliefMeters * strength;
    } else if (landmark.kind === 'impact-basin' || landmark.kind === 'caldera') {
      const floor = 1 - smoothRange(0.34, 0.76, distance);
      const rim = smoothRange(0.48, 0.77, distance)
        * (1 - smoothRange(0.89, 1.24, distance));
      basinStrength = Math.max(basinStrength, floor);
      craterStrength = Math.max(craterStrength, Math.max(floor * 0.9, rim));
      depressionMeters += landmark.reliefMeters * floor;
      upliftMeters += landmark.reliefMeters * rim
        * (landmark.kind === 'caldera' ? 0.78 : 0.36);
      strength = Math.max(floor, rim * 0.8);
    } else if (landmark.kind === 'canyon') {
      const channel = 1 - smoothRange(0.1, 0.84, Math.abs(across));
      const corridorLength = 1 - smoothRange(0.62, 1.1, Math.abs(along));
      strength = channel * corridorLength;
      canyonStrength = Math.max(canyonStrength, strength);
      depressionMeters += landmark.reliefMeters * strength;
    }

    if (strength > strongestFeature) {
      strongestFeature = strength;
      dominantFeature = landmark;
    }
  }

  return {
    heightOffsetMeters: clamp(
      upliftMeters - depressionMeters,
      -profile.maxHeightMeters * 0.24,
      profile.maxHeightMeters * 0.48,
    ),
    mountainStrength: clamp(mountainStrength),
    ridgeStrength: clamp(ridgeStrength),
    plateauStrength: clamp(plateauStrength),
    basinStrength: clamp(basinStrength),
    craterStrength: clamp(craterStrength),
    canyonStrength: clamp(canyonStrength),
    dominantFeatureId: dominantFeature?.id ?? null,
    dominantFeatureDirection: dominantFeature?.centerDirection ?? null,
  };
}
