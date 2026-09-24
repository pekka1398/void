import {
  addAddressOffset,
  addVec3,
  distanceBetweenAddresses,
  scaleVec3,
  vec3,
  type GalacticAddress,
  type Vec3,
} from "../core";
import { catalogFingerprint, generateCatalog, type CatalogGenerationOptions } from "./CatalogGenerator";
import { createCircularOrbit, evaluateOrbit } from "./OrbitPropagator";
import {
  CONTRAST_SYSTEM_ID,
  DEFAULT_UNIVERSE_SEED,
  HERO_PLANET_ID,
  HERO_SYSTEM_ID,
  type BodyPose,
  type PlanetDescriptor,
  type StarDescriptor,
  type StarSystem,
  type SystemSnapshot,
} from "./types";

export interface NearbySystem {
  system: StarSystem;
  distanceMeters: number;
}

export class UniverseCatalog {
  readonly seed: string | number;
  readonly systems: StarSystem[];
  readonly radiusLightYears: number;
  private readonly systemsById = new Map<string, StarSystem>();
  private readonly planetsById = new Map<string, PlanetDescriptor>();
  private readonly starsById = new Map<string, StarDescriptor>();
  private readonly bodySystems = new Map<string, StarSystem>();

  constructor(seedOrOptions: string | number | CatalogGenerationOptions = DEFAULT_UNIVERSE_SEED, systemCount?: number) {
    const options: CatalogGenerationOptions = typeof seedOrOptions === "object"
      ? seedOrOptions
      : { seed: seedOrOptions, ...(systemCount === undefined ? {} : { systemCount }) };
    this.seed = options.seed ?? DEFAULT_UNIVERSE_SEED;
    this.radiusLightYears = options.radiusLightYears ?? 60;
    this.systems = generateCatalog(options);

    for (const system of this.systems) {
      this.systemsById.set(system.id, system);
      for (const star of system.stars) {
        this.starsById.set(star.id, star);
        this.bodySystems.set(star.id, system);
      }
      for (const planet of system.planets) {
        this.planetsById.set(planet.id, planet);
        this.bodySystems.set(planet.id, system);
        for (const moon of planet.moons) {
          this.planetsById.set(moon.id, moon);
          this.bodySystems.set(moon.id, system);
        }
      }
    }
  }

  get count(): number {
    return this.systems.length;
  }

  get heroSystem(): StarSystem {
    return this.requireSystem(HERO_SYSTEM_ID);
  }

  get contrastSystem(): StarSystem {
    return this.requireSystem(CONTRAST_SYSTEM_ID);
  }

  get heroPlanet(): PlanetDescriptor {
    const planet = this.getPlanet(HERO_PLANET_ID);
    if (!planet) throw new Error("The canonical hero planet is missing");
    return planet;
  }

  getSystem(id: string): StarSystem | undefined {
    return this.systemsById.get(id);
  }

  requireSystem(id: string): StarSystem {
    const system = this.getSystem(id);
    if (!system) throw new RangeError(`Unknown star system: ${id}`);
    return system;
  }

  getPlanet(id: string): PlanetDescriptor | undefined {
    return this.planetsById.get(id);
  }

  getStar(id: string): StarDescriptor | undefined {
    return this.starsById.get(id);
  }

  getBody(id: string): StarDescriptor | PlanetDescriptor | undefined {
    return this.starsById.get(id) ?? this.planetsById.get(id);
  }

  getSystemForBody(id: string): StarSystem | undefined {
    return this.bodySystems.get(id);
  }

  nearestSystems(address: GalacticAddress, limit = 8, maxDistanceMeters = Number.POSITIVE_INFINITY): NearbySystem[] {
    return this.systems
      .map((system) => ({ system, distanceMeters: distanceBetweenAddresses(address, system.position) }))
      .filter((entry) => entry.distanceMeters <= maxDistanceMeters)
      .sort((left, right) => left.distanceMeters - right.distanceMeters)
      .slice(0, limit);
  }

  fingerprint(): string {
    return catalogFingerprint(this.systems);
  }

  evaluateSystem(systemOrId: StarSystem | string, timeSeconds = 0): SystemSnapshot {
    const system = typeof systemOrId === "string" ? this.requireSystem(systemOrId) : systemOrId;
    const poses = new Map<string, BodyPose>();
    const stars: BodyPose[] = [];
    const planets: BodyPose[] = [];
    const moons: BodyPose[] = [];

    for (let index = 0; index < system.stars.length; index += 1) {
      const star = system.stars[index]!;
      const localPositionMeters = this.evaluateStarLocalPosition(system, index, timeSeconds);
      const pose: BodyPose = {
        id: star.id,
        systemId: system.id,
        kind: "star",
        localPositionMeters,
        position: addAddressOffset(system.position, localPositionMeters),
        rotationRadians: 0,
      };
      poses.set(star.id, pose);
      stars.push(pose);
    }

    for (const planet of system.planets) {
      const orbitCenter = planet.orbit.parentId === system.id
        ? vec3()
        : poses.get(planet.orbit.parentId)?.localPositionMeters ?? vec3();
      const localPositionMeters = addVec3(orbitCenter, evaluateOrbit(planet.orbit, timeSeconds));
      const pose = this.planetPose(system, planet, localPositionMeters, timeSeconds, "planet");
      poses.set(planet.id, pose);
      planets.push(pose);

      for (const moon of planet.moons) {
        const moonPosition = addVec3(localPositionMeters, evaluateOrbit(moon.orbit, timeSeconds));
        const moonPose = this.planetPose(system, moon, moonPosition, timeSeconds, "moon");
        poses.set(moon.id, moonPose);
        moons.push(moonPose);
      }
    }
    return { system, timeSeconds, stars, planets, moons, poses };
  }

  getBodyPose(id: string, timeSeconds = 0): BodyPose | undefined {
    const system = this.bodySystems.get(id);
    return system ? this.evaluateSystem(system, timeSeconds).poses.get(id) : undefined;
  }

  getBodyAddress(id: string, timeSeconds = 0): GalacticAddress | undefined {
    if (this.systemsById.has(id)) return this.systemsById.get(id)?.position;
    return this.getBodyPose(id, timeSeconds)?.position;
  }

  private planetPose(
    system: StarSystem,
    planet: PlanetDescriptor,
    localPositionMeters: Vec3,
    timeSeconds: number,
    kind: "planet" | "moon",
  ): BodyPose {
    return {
      id: planet.id,
      systemId: system.id,
      kind,
      localPositionMeters,
      position: addAddressOffset(system.position, localPositionMeters),
      rotationRadians: ((timeSeconds / planet.rotationPeriodSeconds) * Math.PI * 2) % (Math.PI * 2),
    };
  }

  private evaluateStarLocalPosition(system: StarSystem, index: number, timeSeconds: number): Vec3 {
    if (system.kind === "single") return vec3();
    const first = system.stars[0]!;
    const second = system.stars[1]!;
    const innerMass = first.massKg + second.massKg;
    const separation = system.binarySeparationMeters ?? 0;
    const innerOrbit = createCircularOrbit(separation, innerMass, system.id, (system.seed % 360) * Math.PI / 180);
    const innerRelative = evaluateOrbit(innerOrbit, timeSeconds);

    let innerBarycenter = vec3();
    if (system.kind === "triple") {
      const outerStar = system.stars[2]!;
      const totalMass = innerMass + outerStar.massKg;
      const outerOrbit = createCircularOrbit(system.outerSeparationMeters ?? separation * 9, totalMass, system.id, 1.4);
      const outerRelative = evaluateOrbit(outerOrbit, timeSeconds);
      innerBarycenter = scaleVec3(outerRelative, -outerStar.massKg / totalMass);
      if (index === 2) return scaleVec3(outerRelative, innerMass / totalMass);
    }

    if (index === 0) return addVec3(innerBarycenter, scaleVec3(innerRelative, -second.massKg / innerMass));
    return addVec3(innerBarycenter, scaleVec3(innerRelative, first.massKg / innerMass));
  }
}
