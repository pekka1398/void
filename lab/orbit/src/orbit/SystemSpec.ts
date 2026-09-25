import { GRAVITATIONAL_CONSTANT } from './Constants';
import { assertEllipticElements, orbitalPeriodSeconds, stateFromElements, type EllipticElements } from './Kepler';
import { add, scale, sub, vec3, type Vec3 } from './Vec3';

export interface RotationSpec {
  /** Sidereal rotation period, seconds, > 0. Retrograde spin uses obliquity > 90 degrees. */
  periodSeconds: number;
  /** Angle between the spin axis and ecliptic north, radians in [0, pi]. */
  obliquityRadians: number;
  /** Ecliptic longitude toward which the spin axis is tilted, radians. */
  poleLongitudeRadians: number;
  /** Prime meridian angle at t = 0, radians. */
  angleAtEpochRadians: number;
}

export interface BodySpec {
  id: string;
  name: string;
  massKg: number;
  radiusMeters: number;
  color: string;
  rotation: RotationSpec;
  /**
   * Jacobi elements: this body's subtree barycenter orbits the barycenter of its
   * parent plus every earlier sibling subtree, with mu = G (M_inner + M_this).
   * Required for every body except the root.
   */
  orbit?: EllipticElements;
  children: BodySpec[];
}

export interface SystemSpec {
  name: string;
  root: BodySpec;
}

export interface CelestialBody {
  index: number;
  id: string;
  name: string;
  massKg: number;
  gm: number;
  radiusMeters: number;
  color: string;
  rotation: RotationSpec;
  parentIndex: number | null;
  /** Jacobi two-body period used for step selection and display, null for the root. */
  orbitPeriodSeconds: number | null;
  /** Jacobi periapsis over semi-major axis ratio, null for the root. */
  periapsisFraction: number | null;
  /** Laplace sphere of influence a (m / M_inner)^(2/5), null for the root. */
  sphereOfInfluenceMeters: number | null;
}

export interface BuiltSystem {
  name: string;
  bodies: CelestialBody[];
  /** Barycentric positions, 3 per body, total momentum and barycenter at zero. */
  positions: Float64Array;
  velocities: Float64Array;
}

interface Placed { index: number; position: Vec3; velocity: Vec3 }

function assertBodySpec(spec: BodySpec, isRoot: boolean): void {
  if (!(spec.massKg > 0) || !Number.isFinite(spec.massKg)) throw new RangeError(`${spec.id}: mass ${spec.massKg}`);
  if (!(spec.radiusMeters > 0) || !Number.isFinite(spec.radiusMeters)) throw new RangeError(`${spec.id}: radius ${spec.radiusMeters}`);
  const rot = spec.rotation;
  if (!(rot.periodSeconds > 0) || !Number.isFinite(rot.periodSeconds)) throw new RangeError(`${spec.id}: rotation period ${rot.periodSeconds}`);
  if (!(rot.obliquityRadians >= 0 && rot.obliquityRadians <= Math.PI)) throw new RangeError(`${spec.id}: obliquity ${rot.obliquityRadians}`);
  if (!Number.isFinite(rot.poleLongitudeRadians) || !Number.isFinite(rot.angleAtEpochRadians)) throw new RangeError(`${spec.id}: rotation angles`);
  if (isRoot && spec.orbit) throw new RangeError(`${spec.id}: the root body cannot have an orbit`);
  if (!isRoot && !spec.orbit) throw new RangeError(`${spec.id}: a non-root body requires an orbit`);
  if (spec.orbit) assertEllipticElements(spec.orbit, spec.id);
}

export function buildSystem(spec: SystemSpec): BuiltSystem {
  const bodies: CelestialBody[] = [];
  const ids = new Set<string>();

  function subtreeMass(node: BodySpec): number {
    return node.children.reduce((sum, child) => sum + subtreeMass(child), node.massKg);
  }

  /** Returns every body of the subtree, relative to the subtree barycenter. */
  function place(node: BodySpec, parentIndex: number | null): Placed[] {
    assertBodySpec(node, parentIndex === null);
    if (ids.has(node.id)) throw new RangeError(`duplicate body id ${node.id}`);
    ids.add(node.id);
    const index = bodies.length;
    bodies.push({
      index,
      id: node.id,
      name: node.name,
      massKg: node.massKg,
      gm: GRAVITATIONAL_CONSTANT * node.massKg,
      radiusMeters: node.radiusMeters,
      color: node.color,
      rotation: { ...node.rotation },
      parentIndex,
      orbitPeriodSeconds: null,
      periapsisFraction: null,
      sphereOfInfluenceMeters: null,
    });

    let placed: Placed[] = [{ index, position: vec3(0, 0, 0), velocity: vec3(0, 0, 0) }];
    let innerMass = node.massKg;
    let innerBaryPosition = vec3(0, 0, 0);
    let innerBaryVelocity = vec3(0, 0, 0);

    for (const child of node.children) {
      const childPlaced = place(child, index);
      const childMass = subtreeMass(child);
      const orbit = child.orbit;
      if (!orbit) throw new RangeError(`${child.id}: missing orbit`);
      const gm = GRAVITATIONAL_CONSTANT * (innerMass + childMass);
      const relative = stateFromElements(orbit, gm);
      const childBody = bodies[childPlaced[0]!.index]!;
      childBody.orbitPeriodSeconds = orbitalPeriodSeconds(orbit.semiMajorAxisMeters, gm);
      childBody.periapsisFraction = 1 - orbit.eccentricity;
      childBody.sphereOfInfluenceMeters = orbit.semiMajorAxisMeters * (childMass / innerMass) ** 0.4;

      const childBaryPosition = add(innerBaryPosition, relative.position);
      const childBaryVelocity = add(innerBaryVelocity, relative.velocity);
      for (const p of childPlaced) {
        placed.push({
          index: p.index,
          position: add(childBaryPosition, p.position),
          velocity: add(childBaryVelocity, p.velocity),
        });
      }
      const total = innerMass + childMass;
      innerBaryPosition = scale(add(scale(innerBaryPosition, innerMass), scale(childBaryPosition, childMass)), 1 / total);
      innerBaryVelocity = scale(add(scale(innerBaryVelocity, innerMass), scale(childBaryVelocity, childMass)), 1 / total);
      innerMass = total;
    }

    placed = placed.map((p) => ({
      index: p.index,
      position: sub(p.position, innerBaryPosition),
      velocity: sub(p.velocity, innerBaryVelocity),
    }));
    return placed;
  }

  const placed = place(spec.root, null);
  const positions = new Float64Array(bodies.length * 3);
  const velocities = new Float64Array(bodies.length * 3);
  for (const p of placed) {
    positions[p.index * 3] = p.position.x;
    positions[p.index * 3 + 1] = p.position.y;
    positions[p.index * 3 + 2] = p.position.z;
    velocities[p.index * 3] = p.velocity.x;
    velocities[p.index * 3 + 1] = p.velocity.y;
    velocities[p.index * 3 + 2] = p.velocity.z;
  }
  return { name: spec.name, bodies, positions, velocities };
}
