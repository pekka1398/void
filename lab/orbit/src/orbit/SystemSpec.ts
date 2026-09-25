import { GRAVITATIONAL_CONSTANT } from './Constants';
import { assertEllipticElements, orbitalPeriodSeconds, solveKeplerElliptic, stateFromElements, type EllipticElements } from './Kepler';
import { add, cross, dot, length, normalize, scale, sub, vec3, type Vec3 } from './Vec3';

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

/**
 * Tidally locked (synchronous) rotation, resolved by buildSystem from the
 * body's initial orbit about its parent body:
 * - period: given, the mean sidereal period of the perturbed orbit (the
 *   two-body period can differ by a percent when a third body perturbs it);
 * - spin axis: the orbit normal tilted by obliquityToOrbit toward and past
 *   ecliptic north, in the plane of both (Cassini state 2, like the Moon,
 *   whose ecliptic pole lies between its orbit normal and spin axis);
 * - prime meridian facing the parent's mean direction at t = 0: the true
 *   direction minus the equation of centre (true minus mean anomaly), as
 *   the Moon's near side faces the mean Earth.
 * Libration and the slow drift between the constant spin and the perturbed
 * orbit are real effects of this model, not errors.
 */
export interface LockedRotationSpec {
  kind: 'locked';
  periodSeconds: number;
  /** Angle between spin axis and orbit normal, radians in [0, pi/2). */
  obliquityToOrbitRadians: number;
}

export interface BodySpec {
  id: string;
  name: string;
  massKg: number;
  radiusMeters: number;
  color: string;
  rotation: RotationSpec | LockedRotationSpec;
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
  if ('kind' in rot) {
    if (isRoot) throw new RangeError(`${spec.id}: the root body cannot be tidally locked`);
    if (!(rot.periodSeconds > 0) || !Number.isFinite(rot.periodSeconds)) throw new RangeError(`${spec.id}: locked period ${rot.periodSeconds}`);
    if (!(rot.obliquityToOrbitRadians >= 0 && rot.obliquityToOrbitRadians < Math.PI / 2)) {
      throw new RangeError(`${spec.id}: obliquity to orbit ${rot.obliquityToOrbitRadians}`);
    }
    return assertOrbit(spec, isRoot);
  }
  if (!(rot.periodSeconds > 0) || !Number.isFinite(rot.periodSeconds)) throw new RangeError(`${spec.id}: rotation period ${rot.periodSeconds}`);
  if (!(rot.obliquityRadians >= 0 && rot.obliquityRadians <= Math.PI)) throw new RangeError(`${spec.id}: obliquity ${rot.obliquityRadians}`);
  if (!Number.isFinite(rot.poleLongitudeRadians) || !Number.isFinite(rot.angleAtEpochRadians)) throw new RangeError(`${spec.id}: rotation angles`);
  assertOrbit(spec, isRoot);
}

function assertOrbit(spec: BodySpec, isRoot: boolean): void {
  if (isRoot && spec.orbit) throw new RangeError(`${spec.id}: the root body cannot have an orbit`);
  if (!isRoot && !spec.orbit) throw new RangeError(`${spec.id}: a non-root body requires an orbit`);
  if (spec.orbit) assertEllipticElements(spec.orbit, spec.id);
}

/** Placeholder until the parent resolves a locked rotation; never left in a built system. */
const UNRESOLVED_ROTATION: RotationSpec = { periodSeconds: Number.NaN, obliquityRadians: Number.NaN, poleLongitudeRadians: Number.NaN, angleAtEpochRadians: Number.NaN };

/** r, v: the locked body relative to its parent body at t = 0. */
function lockedRotation(spec: LockedRotationSpec, orbit: EllipticElements, r: Vec3, v: Vec3): RotationSpec {
  const normal = normalize(cross(r, v));
  const north: Vec3 = { x: 0, y: 0, z: 1 };
  const ob = spec.obliquityToOrbitRadians;
  let axis = normal;
  if (ob > 0) {
    const towardNorth = sub(north, scale(normal, dot(north, normal)));
    if (!(length(towardNorth) > 1e-12)) throw new RangeError('locked rotation: tilt direction undefined for an orbit in the ecliptic');
    axis = add(scale(normal, Math.cos(ob)), scale(normalize(towardNorth), Math.sin(ob)));
  }
  const obliquity = Math.acos(Math.min(1, Math.max(-1, axis.z)));
  const lon = Math.atan2(axis.y, axis.x);
  // Same equatorial axes as BodyRotation.equatorialAxes.
  const node: Vec3 = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
  const quadrature = cross(axis, node);
  const toParent = scale(r, -1);
  const e = orbit.eccentricity;
  const E = solveKeplerElliptic(orbit.meanAnomalyRadians, e);
  const trueAnomaly = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const centre = Math.atan2(Math.sin(trueAnomaly - orbit.meanAnomalyRadians), Math.cos(trueAnomaly - orbit.meanAnomalyRadians));
  return {
    periodSeconds: spec.periodSeconds,
    obliquityRadians: obliquity,
    poleLongitudeRadians: lon,
    angleAtEpochRadians: Math.atan2(dot(toParent, quadrature), dot(toParent, node)) - centre,
  };
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
      // A locked rotation is resolved by the parent once the orbit is placed.
      rotation: 'kind' in node.rotation ? UNRESOLVED_ROTATION : { ...node.rotation },
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
      if ('kind' in child.rotation) {
        // This node sits at the origin of the frame the child is placed in.
        childBody.rotation = lockedRotation(
          child.rotation, orbit,
          add(childBaryPosition, childPlaced[0]!.position), add(childBaryVelocity, childPlaced[0]!.velocity),
        );
      }
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
  for (const body of bodies) {
    if (!Number.isFinite(body.rotation.periodSeconds)) throw new Error(`buildSystem: ${body.id} rotation left unresolved`);
  }
  return { name: spec.name, bodies, positions, velocities };
}
