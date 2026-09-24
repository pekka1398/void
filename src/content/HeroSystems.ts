import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  rotateAroundYAxis,
  scaleVec3,
  subVec3,
  vec3,
  type Vec3,
} from "../core";
import { createPlanetField } from "../fields";
import { TerrainCollision } from "../terrain";
import {
  DEFAULT_UNIVERSE_SEED,
  type BodyPose,
  type PlanetDescriptor,
  type StarSystem,
  UniverseCatalog,
} from "../universe";

const DEFAULT_SHOWCASE_HERO_PLANET_SEED = 3_262_055_451;
const DEFAULT_BINARY_SUNSET_DIRECTION = normalizeVec3(vec3(
  0.24991920433533008,
  0.8676060478219769,
  0.42988386465082096,
));

/**
 * The canonical hero seed has a genuine safe shore directly on its binary
 * terminator. Its real ocean opens to the sun-facing camera's right while
 * dry mountain country rises to the left. Keep the selected point exact: the
 * generic optimizer otherwise drifts to a valid but compositionally mirrored coast.
 */
function findDefaultBinarySunsetCoast(
  catalog: UniverseCatalog,
  planet: PlanetDescriptor,
  collision: TerrainCollision,
): Vec3 | undefined {
  if (catalog.seed !== DEFAULT_UNIVERSE_SEED || planet.seed !== DEFAULT_SHOWCASE_HERO_PLANET_SEED) {
    return undefined;
  }

  const direction = DEFAULT_BINARY_SUNSET_DIRECTION;
  const landing = collision.evaluateLanding(direction, { maxSlopeDegrees: 20 });
  if (!landing.safe || landing.surface.heightMeters > 1_200) return undefined;

  const snapshot = catalog.evaluateSystem(catalog.heroSystem, 0);
  const planetPose = snapshot.poses.get(planet.id);
  if (!planetPose) return undefined;

  let sunward = vec3();
  for (const star of snapshot.stars) {
    const starward = normalizeVec3(subVec3(star.localPositionMeters, planetPose.localPositionMeters));
    const elevation = dotVec3(direction, starward);
    if (elevation <= 0 || elevation > Math.sin(18 * Math.PI / 180)) return undefined;
    sunward = addVec3(sunward, starward);
  }

  const averageSunward = normalizeVec3(sunward);
  const sunwardTangent = normalizeVec3(subVec3(
    averageSunward,
    scaleVec3(direction, dotVec3(averageSunward, direction)),
  ));
  const acrossSunward = normalizeVec3(crossVec3(direction, sunwardTangent));

  // Both genuine binary suns and the real shoreline must fit the same view;
  // a wet sample thirty kilometers sideways does not form a visible coastline.
  for (const azimuthDegrees of [0, 12, 18, 24, -12, -24]) {
    const azimuth = azimuthDegrees * Math.PI / 180;
    const tangent = addVec3(
      scaleVec3(sunwardTangent, Math.cos(azimuth)),
      scaleVec3(acrossSunward, Math.sin(azimuth)),
    );
    for (const meters of [450, 700, 900, 1_100]) {
      const neighbor = normalizeVec3(addVec3(direction, scaleVec3(tangent, meters / planet.radiusMeters)));
      if (collision.sample(neighbor).ocean) return direction;
    }
  }

  return undefined;
}

export interface HeroScenarios {
  system: StarSystem;
  planet: PlanetDescriptor;
  contrastSystem: StarSystem;
  planetPose: BodyPose;
  bodyFixedCoastalDirection: Vec3;
  coastalDirection: Vec3;
  bodyFixedRingDirection: Vec3;
  ringDirection: Vec3;
  surfaceHeightMeters: number;
  orbitSpawn: Vec3;
  ringPosition: Vec3;
  atmosphericEntry: Vec3;
  surfaceApproach: Vec3;
  landingPosition: Vec3;
}

/** Derived scenario coordinates reference actual seeded worlds; they are never gameplay teleports. */
export function createHeroScenarios(catalog: UniverseCatalog, timeSeconds = 0): HeroScenarios {
  const system = catalog.heroSystem;
  const planet = catalog.heroPlanet;
  const snapshot = catalog.evaluateSystem(system, timeSeconds);
  const planetPose = snapshot.poses.get(planet.id);
  if (!planetPose) throw new Error("Hero planet has no current orbital pose");

  const field = createPlanetField(planet);
  const collision = new TerrainCollision(field);
  const preferred = normalizeVec3(vec3(0.22, 0.13, 0.97));
  const showcaseDirection = findDefaultBinarySunsetCoast(catalog, planet, collision);
  const candidate = showcaseDirection ?? collision.findCoastalLandingDirection(preferred, 128);
  const bodyFixedCoastalDirection = candidate ? vec3(candidate.x, candidate.y, candidate.z) : preferred;
  const coastalDirection = rotateAroundYAxis(bodyFixedCoastalDirection, planetPose.rotationRadians);
  const surfaceHeightMeters = Math.max(0, collision.sample(bodyFixedCoastalDirection).heightMeters);
  const ringRadius = planet.ring
    ? planet.ring.outerRadiusMeters * 0.94
    : planet.radiusMeters * 1.8;

  let sunward = vec3();
  for (const star of snapshot.stars) {
    sunward = addVec3(sunward, normalizeVec3(subVec3(star.localPositionMeters, planetPose.localPositionMeters)));
  }
  const bodyFixedSunward = rotateAroundYAxis(
    lengthVec3(sunward) > 0 ? normalizeVec3(sunward) : bodyFixedCoastalDirection,
    -planetPose.rotationRadians,
  );
  const tilt = planet.ring?.tiltRadians ?? 0;
  const bodyFixedRingNormal = normalizeVec3(vec3(-Math.sin(tilt), Math.cos(tilt), 0));
  const inPlaneSunward = subVec3(
    bodyFixedSunward,
    scaleVec3(bodyFixedRingNormal, dotVec3(bodyFixedSunward, bodyFixedRingNormal)),
  );
  const bodyFixedRingDirection = lengthVec3(inPlaneSunward) > 0.000_001
    ? normalizeVec3(inPlaneSunward)
    : normalizeVec3(crossVec3(bodyFixedRingNormal, vec3(0, 0, 1)));
  const ringDirection = rotateAroundYAxis(bodyFixedRingDirection, planetPose.rotationRadians);

  const atRadius = (radiusMeters: number): Vec3 => addVec3(planetPose.localPositionMeters, scaleVec3(coastalDirection, radiusMeters));
  return {
    system,
    planet,
    contrastSystem: catalog.contrastSystem,
    planetPose,
    bodyFixedCoastalDirection,
    coastalDirection,
    bodyFixedRingDirection,
    ringDirection,
    surfaceHeightMeters,
    orbitSpawn: atRadius(planet.radiusMeters * 3.65),
    ringPosition: addVec3(planetPose.localPositionMeters, scaleVec3(ringDirection, ringRadius)),
    atmosphericEntry: atRadius(planet.radiusMeters + planet.atmosphere.heightMeters * 0.9),
    surfaceApproach: atRadius(planet.radiusMeters + surfaceHeightMeters + 2_400),
    landingPosition: atRadius(planet.radiusMeters + surfaceHeightMeters + 90),
  };
}
