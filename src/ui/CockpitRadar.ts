import {
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  type Vec3,
} from '../core';
import type {
  BodyPose,
  PlanetDescriptor,
  StarDescriptor,
  StarSystem,
  SystemSnapshot,
} from '../universe';

const DEFAULT_MAX_CONTACTS = 24;
const MAXIMUM_CONTACTS = 32;
const MINIMUM_LOG_REFERENCE_METERS = 250_000;
const EPSILON = 1e-12;
const SYSTEM_DESCRIPTORS = new WeakMap<
  StarSystem,
  ReadonlyMap<string, StarDescriptor | PlanetDescriptor>
>();

export type CockpitRadarKind = 'star' | 'planet' | 'moon';

export interface CockpitRadarOptions {
  /** Actual float64 ship position in this snapshot's barycentric meter frame. */
  shipPositionMeters: Vec3;
  /** The actual flight controller's normalized world-space heading. */
  forward: Vec3;
  /** Real body-relative ship up near planets; system +Y is valid in deep space. */
  referenceUp?: Vec3;
  activeTargetId?: string;
  maxContacts?: number;
  /** Optional explicit physical scope radius; omitted scopes fit real contacts. */
  rangeMeters?: number;
}

export interface CockpitRadarContact {
  id: string;
  name: string;
  kind: CockpitRadarKind;
  parentId?: string;
  color: string;
  /** Genuine distance from the ship to the descriptor's physical surface. */
  distanceMeters: number;
  /** Genuine ship-to-body-center distance in the shared system frame. */
  centerDistanceMeters: number;
  /** Zero is directly ahead; positive bearings lie to the ship's actual right. */
  bearingRadians: number;
  elevationRadians: number;
  /** Actual signed barycentric-meter components in the real ship frame. */
  rightMeters: number;
  forwardMeters: number;
  verticalMeters: number;
  /** Logarithmic radius derived from full 3D center distance, never planar distance. */
  normalizedRadius: number;
  /** Actual signed elevation projected onto the bounded logarithmic 3D scope. */
  height: number;
  /** Normalized scope coordinates: +x right; -y is the ship's real forward. */
  x: number;
  y: number;
  selected: boolean;
  behind: boolean;
  clipped: boolean;
}

export interface CockpitRadarSnapshot {
  systemId: string;
  systemName: string;
  timeSeconds: number;
  /** Physical center-distance represented by the edge of the scope. */
  rangeMeters: number;
  /** Same barycentric x/z heading convention already used by the system map. */
  headingRadians: number;
  /** Count only actual, valid, descriptor-backed current-system bodies. */
  totalActualContacts: number;
  contacts: CockpitRadarContact[];
  selectedTargetId?: string;
  selectedDistanceMeters?: number;
}

interface ActualContact {
  id: string;
  name: string;
  kind: CockpitRadarKind;
  parentId?: string;
  color: string;
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  centerDistanceMeters: number;
  distanceMeters: number;
  selected: boolean;
}

interface ShipRadarFrame {
  forward: Vec3;
  planarForward: Vec3;
  right: Vec3;
  up: Vec3;
}

function finiteVector(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function requireFiniteVector(value: Vec3, label: string): void {
  if (!finiteVector(value)) {
    throw new RangeError(`Cockpit radar requires an actual finite ${label}.`);
  }
}

function actualShipFrame(options: CockpitRadarOptions): ShipRadarFrame {
  requireFiniteVector(options.shipPositionMeters, 'ship position');
  requireFiniteVector(options.forward, 'ship heading');
  if (lengthVec3(options.forward) < EPSILON) {
    throw new RangeError('Cockpit radar requires a nonzero actual ship heading.');
  }

  const forward = normalizeVec3(options.forward);
  const suppliedUp = options.referenceUp ?? { x: 0, y: 1, z: 0 };
  requireFiniteVector(suppliedUp, 'ship up vector');
  const up = lengthVec3(suppliedUp) >= EPSILON
    ? normalizeVec3(suppliedUp)
    : { x: 0, y: 1, z: 0 };
  const verticalForward = dotVec3(forward, up);
  let planarForward = {
    x: forward.x - up.x * verticalForward,
    y: forward.y - up.y * verticalForward,
    z: forward.z - up.z * verticalForward,
  };

  if (lengthVec3(planarForward) < EPSILON) {
    // A real vertical liftoff has no horizontal heading. Use an existing
    // barycentric coordinate axis rather than inventing a target direction.
    const reference = Math.abs(up.x) < 0.8
      ? { x: 1, y: 0, z: 0 }
      : { x: 0, y: 0, z: 1 };
    const verticalReference = dotVec3(reference, up);
    planarForward = {
      x: reference.x - up.x * verticalReference,
      y: reference.y - up.y * verticalReference,
      z: reference.z - up.z * verticalReference,
    };
  }

  planarForward = normalizeVec3(planarForward);
  const right = normalizeVec3(crossVec3(planarForward, up));
  return { forward, planarForward, right, up };
}

function actualContact(
  pose: BodyPose,
  descriptor: StarDescriptor | PlanetDescriptor,
  kind: CockpitRadarKind,
  options: CockpitRadarOptions,
): ActualContact | undefined {
  if (pose.kind !== kind || pose.systemId !== descriptor.systemId ||
      !finiteVector(pose.localPositionMeters) ||
      !Number.isFinite(descriptor.radiusMeters) || descriptor.radiusMeters < 0) {
    return undefined;
  }

  const deltaX = pose.localPositionMeters.x - options.shipPositionMeters.x;
  const deltaY = pose.localPositionMeters.y - options.shipPositionMeters.y;
  const deltaZ = pose.localPositionMeters.z - options.shipPositionMeters.z;
  const centerDistanceMeters = Math.hypot(deltaX, deltaY, deltaZ);
  const color = kind === 'star'
    ? (descriptor as StarDescriptor).color
    : (descriptor as PlanetDescriptor).colors.atmosphere;

  return {
    id: descriptor.id,
    name: descriptor.name,
    kind,
    ...(kind === 'moon' && (descriptor as PlanetDescriptor).parentPlanetId
      ? { parentId: (descriptor as PlanetDescriptor).parentPlanetId }
      : {}),
    color,
    deltaX,
    deltaY,
    deltaZ,
    centerDistanceMeters,
    distanceMeters: Math.max(0, centerDistanceMeters - descriptor.radiusMeters),
    selected: descriptor.id === options.activeTargetId,
  };
}

function prioritizeActualContacts(first: ActualContact, second: ActualContact): number {
  if (first.selected !== second.selected) return first.selected ? -1 : 1;
  const firstStellar = first.kind === 'star';
  const secondStellar = second.kind === 'star';
  if (firstStellar !== secondStellar) return firstStellar ? -1 : 1;
  return first.distanceMeters - second.distanceMeters || first.id.localeCompare(second.id);
}

/** Star-system descriptors are immutable; the changing orbital poses are not. */
function cachedSystemDescriptors(
  system: StarSystem,
): ReadonlyMap<string, StarDescriptor | PlanetDescriptor> {
  const cached = SYSTEM_DESCRIPTORS.get(system);
  if (cached) return cached;

  const descriptors = new Map<string, StarDescriptor | PlanetDescriptor>();
  for (const star of system.stars) descriptors.set(star.id, star);
  for (const planet of system.planets) {
    descriptors.set(planet.id, planet);
    for (const moon of planet.moons) descriptors.set(moon.id, moon);
  }
  SYSTEM_DESCRIPTORS.set(system, descriptors);
  return descriptors;
}

function collectActualContacts(
  poses: readonly BodyPose[],
  kind: CockpitRadarKind,
  systemId: string,
  descriptors: ReadonlyMap<string, StarDescriptor | PlanetDescriptor>,
  options: CockpitRadarOptions,
  seen: Set<string>,
  output: ActualContact[],
): void {
  for (const pose of poses) {
    if (seen.has(pose.id) || pose.systemId !== systemId) continue;
    const descriptor = descriptors.get(pose.id);
    if (!descriptor || descriptor.systemId !== systemId) continue;
    const contact = actualContact(pose, descriptor, kind, options);
    if (!contact) continue;
    seen.add(contact.id);
    output.push(contact);
  }
}

/**
 * Project only moving, descriptor-backed current-system stars/planets/moons.
 *
 * The caller passes its existing same-epoch system snapshot. This function
 * never evaluates another orbit, scans the 2,048-system catalog, invents a
 * star, or changes authoritative ship/body positions.
 */
export function buildCockpitRadar(
  snapshot: SystemSnapshot,
  options: CockpitRadarOptions,
): CockpitRadarSnapshot {
  const frame = actualShipFrame(options);
  const system = snapshot.system;
  const descriptorById = cachedSystemDescriptors(system);
  const candidates: ActualContact[] = [];
  const seen = new Set<string>();
  collectActualContacts(snapshot.stars, 'star', system.id, descriptorById, options, seen, candidates);
  collectActualContacts(snapshot.planets, 'planet', system.id, descriptorById, options, seen, candidates);
  collectActualContacts(snapshot.moons, 'moon', system.id, descriptorById, options, seen, candidates);

  candidates.sort(prioritizeActualContacts);
  const maximum = Number.isFinite(options.maxContacts)
    ? Math.max(1, Math.min(MAXIMUM_CONTACTS, Math.trunc(options.maxContacts!)))
    : DEFAULT_MAX_CONTACTS;
  const visible = candidates.length > maximum ? candidates.slice(0, maximum) : candidates;
  let farthest = 1;
  let nearest = Number.POSITIVE_INFINITY;
  for (const entry of visible) {
    farthest = Math.max(farthest, entry.centerDistanceMeters);
    if (entry.centerDistanceMeters > EPSILON) {
      nearest = Math.min(nearest, entry.centerDistanceMeters);
    }
  }
  const rangeMeters = options.rangeMeters !== undefined &&
    Number.isFinite(options.rangeMeters) && options.rangeMeters > 0
    ? options.rangeMeters
    : farthest;
  const referenceMeters = Math.max(1, Math.min(
    rangeMeters * 0.18,
    Math.max(MINIMUM_LOG_REFERENCE_METERS,
      Number.isFinite(nearest) ? nearest * 0.45 : rangeMeters * 0.08),
  ));
  const logarithmicRange = Math.log1p(rangeMeters / referenceMeters);

  const contacts: CockpitRadarContact[] = [];
  let selected: CockpitRadarContact | undefined;
  for (const entry of visible) {
    const horizontal = entry.deltaX * frame.right.x +
      entry.deltaY * frame.right.y + entry.deltaZ * frame.right.z;
    const forward = entry.deltaX * frame.planarForward.x +
      entry.deltaY * frame.planarForward.y + entry.deltaZ * frame.planarForward.z;
    const vertical = entry.deltaX * frame.up.x +
      entry.deltaY * frame.up.y + entry.deltaZ * frame.up.z;
    const planarDistance = Math.hypot(horizontal, forward);
    const projectedRadius = logarithmicRange > 0
      ? Math.min(1, Math.log1p(planarDistance / referenceMeters) / logarithmicRange)
      : 0;
    const normalizedRadius = logarithmicRange > 0
      ? Math.min(1, Math.log1p(entry.centerDistanceMeters / referenceMeters) / logarithmicRange)
      : 0;
    const inversePlanarDistance = planarDistance > EPSILON ? 1 / planarDistance : 0;
    const height = entry.centerDistanceMeters > EPSILON
      ? Math.max(-1, Math.min(1, vertical / entry.centerDistanceMeters * normalizedRadius))
      : 0;

    const contact: CockpitRadarContact = {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      ...(entry.parentId ? { parentId: entry.parentId } : {}),
      color: entry.color,
      distanceMeters: entry.distanceMeters,
      centerDistanceMeters: entry.centerDistanceMeters,
      bearingRadians: Math.atan2(horizontal, forward),
      elevationRadians: Math.atan2(vertical, planarDistance),
      rightMeters: horizontal,
      forwardMeters: forward,
      verticalMeters: vertical,
      normalizedRadius,
      height,
      x: horizontal * inversePlanarDistance * projectedRadius,
      y: -forward * inversePlanarDistance * projectedRadius,
      selected: entry.selected,
      behind: entry.deltaX * frame.forward.x +
        entry.deltaY * frame.forward.y + entry.deltaZ * frame.forward.z < 0,
      clipped: entry.centerDistanceMeters > rangeMeters,
    };
    contacts.push(contact);
    if (contact.selected) selected = contact;
  }
  return {
    systemId: system.id,
    systemName: system.name,
    timeSeconds: snapshot.timeSeconds,
    rangeMeters,
    headingRadians: Math.atan2(frame.forward.z, frame.forward.x),
    totalActualContacts: candidates.length,
    contacts,
    ...(options.activeTargetId ? { selectedTargetId: options.activeTargetId } : {}),
    ...(selected ? { selectedDistanceMeters: selected.distanceMeters } : {}),
  };
}
