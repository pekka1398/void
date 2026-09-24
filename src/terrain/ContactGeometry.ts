import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../core/Vec3';
import { samplePlanetField, type PlanetField, type Rgb } from '../fields';
import { buildContactFeatures } from './ContactFeatures';
import { createSurfaceFlowRegionTask } from './SurfaceFlowField';
import { isValidSurfaceFlowDescriptor } from './SurfaceFlowGeometry';
import { createSurfaceTerrainPalette, sampleSurfaceTerrainColor, shadeSurfaceTerrainFacet } from './SurfaceTerrainPresentation';

export type ContactLeaseKind = 'parked-ship' | 'actor';

export interface ContactLease {
  readonly id: string;
  readonly kind: ContactLeaseKind;
  readonly bodyId: string;
  readonly centerDirection: Readonly<Vec3>;
  /** Half-width of the square coverage in physical tangent meters. */
  readonly radiusMeters: number;
  readonly requiredCellMeters: number;
  readonly token: number;
}

export interface ContactLeaseRequest {
  id?: string;
  kind: ContactLeaseKind;
  bodyId: string;
  centerDirection: Readonly<Vec3>;
  radiusMeters?: number;
  requiredCellMeters?: number;
}

/** Highest physical/presentation ownership sorts first, independently of commit order. */
export function compareContactLeaseOwnership(
  left: Pick<ContactLease, 'id' | 'kind' | 'requiredCellMeters'>,
  right: Pick<ContactLease, 'id' | 'kind' | 'requiredCellMeters'>,
): number {
  const resolution = left.requiredCellMeters - right.requiredCellMeters;
  if (resolution !== 0) return resolution;
  const kind = Number(right.kind === 'actor') - Number(left.kind === 'actor');
  if (kind !== 0) return kind;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

export interface ContactTangentFrame {
  readonly originBodyFixedMeters: Readonly<Vec3>;
  readonly eastBodyFixed: Readonly<Vec3>;
  readonly upBodyFixed: Readonly<Vec3>;
  /** east cross up; x=east, y=up, z=north is right-handed. */
  readonly northBodyFixed: Readonly<Vec3>;
}

export interface ContactSolidDescriptor {
  readonly id: string;
  readonly kind: 'rock' | 'ridge' | 'crystal';
  readonly centerBodyFixedMeters: Readonly<Vec3>;
  readonly halfExtentsMeters: Readonly<Vec3>;
  readonly rightBodyFixed: Readonly<Vec3>;
  readonly upBodyFixed: Readonly<Vec3>;
  readonly forwardBodyFixed: Readonly<Vec3>;
  readonly color: Rgb;
  readonly variation: number;
}

export interface ContactFlowDescriptor {
  readonly id: string;
  readonly kind: 'river' | 'lava';
  readonly centerDirection: Readonly<Vec3>;
  readonly headingBodyFixed: Readonly<Vec3>;
  readonly halfLengthMeters: number;
  readonly halfWidthMeters: number;
  readonly strength?: number;
  readonly variation?: number;
  readonly appearance?: 'channel' | 'cascade';
  /** Exactly the four rendered corners, ordered left-back, right-back, left-front, right-front. */
  readonly cornersBodyFixedMeters: readonly [Readonly<Vec3>, Readonly<Vec3>, Readonly<Vec3>, Readonly<Vec3>];
}

/** One immutable, transferable physical generation. Never stores galaxy-scale float32 positions. */
export interface ContactSurfaceGeneration extends ContactTangentFrame {
  readonly id: string;
  readonly bodyId: string;
  readonly leaseId: string;
  readonly token: number;
  readonly fieldSeed: number;
  readonly fieldVersion: number;
  readonly bodyRadiusMeters: number;
  readonly centerDirection: Readonly<Vec3>;
  readonly radiusMeters: number;
  readonly cellMeters: number;
  readonly segments: number;
  /** Local tangent meters. The same positions and triangles feed rendering and physics. */
  readonly vertices: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  readonly solids: readonly ContactSolidDescriptor[];
  readonly flows: readonly ContactFlowDescriptor[];
  readonly flowOriginBodyFixedMeters?: Readonly<Vec3>;
  readonly flowReferenceDirections?: Readonly<{ river?: Readonly<Vec3>; lava?: Readonly<Vec3> }>;
  readonly byteLength: number;
}

export interface ContactGeometryOptions {
  maxSolids?: number;
  maxFlows?: number;
  /** Immutable region shared with the existing distant river/lava renderer. */
  sourceFlows?: readonly ContactFlowDescriptor[];
  sourceFlowOriginBodyFixedMeters?: Readonly<Vec3>;
}

export interface ContactTriangleSample {
  pointBodyFixedMeters: Vec3;
  normalBodyFixed: Vec3;
  groundRadiusMeters: number;
  triangleIndex: number;
}

export const CONTACT_SURFACE_LIMITS = Object.freeze({
  high: Object.freeze({ radiusMeters: 80, cellMeters: 1, maxSolids: 40, maxFlows: 64 }),
  low: Object.freeze({ radiusMeters: 64, cellMeters: 1.5, maxSolids: 24, maxFlows: 64 }),
  maximumRadiusMeters: 96,
  minimumRadiusMeters: 16,
  maximumSegments: 192,
  maximumLeases: 2,
});

/** Maximum grid samples, shaded vertices, or indexed cells in one cooperative step. */
export const CONTACT_SURFACE_GENERATION_BATCH_SIZE = 64;

export function createContactTangentFrame(
  directionInput: Readonly<Vec3>,
  originRadiusMeters: number,
): ContactTangentFrame {
  const upBodyFixed = normalizeVec3(directionInput);
  if (lengthVec3(upBodyFixed) < 0.5) throw new RangeError('A contact frame needs a nonzero body direction.');
  const reference = Math.abs(upBodyFixed.y) > 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const eastBodyFixed = normalizeVec3(crossVec3(reference, upBodyFixed));
  const northBodyFixed = normalizeVec3(crossVec3(eastBodyFixed, upBodyFixed));
  return {
    originBodyFixedMeters: scaleVec3(upBodyFixed, originRadiusMeters),
    eastBodyFixed,
    upBodyFixed,
    northBodyFixed,
  };
}

export function contactLocalToBodyFixed(frame: ContactTangentFrame, localMeters: Readonly<Vec3>): Vec3 {
  return addVec3(frame.originBodyFixedMeters, addVec3(
    scaleVec3(frame.eastBodyFixed, localMeters.x),
    addVec3(scaleVec3(frame.upBodyFixed, localMeters.y), scaleVec3(frame.northBodyFixed, localMeters.z)),
  ));
}

export function bodyFixedToContactLocal(frame: ContactTangentFrame, bodyFixedMeters: Readonly<Vec3>): Vec3 {
  const relative = subVec3(bodyFixedMeters, frame.originBodyFixedMeters);
  return {
    x: dotVec3(relative, frame.eastBodyFixed),
    y: dotVec3(relative, frame.upBodyFixed),
    z: dotVec3(relative, frame.northBodyFixed),
  };
}

export function contactDirectionAt(
  frame: Pick<ContactTangentFrame, 'eastBodyFixed' | 'upBodyFixed' | 'northBodyFixed'>,
  bodyRadiusMeters: number,
  xMeters: number,
  zMeters: number,
): Vec3 {
  return normalizeVec3(addVec3(frame.upBodyFixed, addVec3(
    scaleVec3(frame.eastBodyFixed, xMeters / bodyRadiusMeters),
    scaleVec3(frame.northBodyFixed, zMeters / bodyRadiusMeters),
  )));
}

/** Gnomonic coordinates invert the exact radial grid used by the worker. */
export function contactGridCoordinates(
  generation: Pick<ContactSurfaceGeneration, 'eastBodyFixed' | 'upBodyFixed' | 'northBodyFixed' | 'bodyRadiusMeters'>,
  directionInput: Readonly<Vec3>,
): { x: number; z: number } | null {
  const direction = normalizeVec3(directionInput);
  const facing = dotVec3(direction, generation.upBodyFixed);
  if (facing <= 0) return null;
  return {
    x: generation.bodyRadiusMeters * dotVec3(direction, generation.eastBodyFixed) / facing,
    z: generation.bodyRadiusMeters * dotVec3(direction, generation.northBodyFixed) / facing,
  };
}

export function contactGenerationContains(
  generation: ContactSurfaceGeneration,
  bodyFixedPositionMeters: Readonly<Vec3>,
  marginMeters = 0,
): boolean {
  const local = contactGridCoordinates(generation, bodyFixedPositionMeters);
  const extent = generation.radiusMeters - Math.max(0, marginMeters);
  return local !== null && extent >= 0 && Math.abs(local.x) <= extent + 1e-7 && Math.abs(local.z) <= extent + 1e-7;
}

/**
 * Produce one immutable physical generation in bounded deterministic steps.
 * Nothing becomes collision-ready until the complete result is atomically
 * published by the contact authority.
 */
export function* createContactSurfaceGenerationTask(
  field: PlanetField,
  lease: ContactLease,
  options: ContactGeometryOptions = {},
): Generator<void, ContactSurfaceGeneration, void> {
  if (!field.landable) throw new RangeError('Gas giants cannot own a contact mesh.');
  const centerDirection = normalizeVec3(lease.centerDirection);
  const centerSample = samplePlanetField(field, centerDirection);
  if (!Number.isFinite(centerSample.heightMeters) || !Number.isFinite(field.radius) || field.radius <= 0) {
    throw new RangeError('Contact geometry requires a finite authoritative heightfield.');
  }
  const frame = createContactTangentFrame(centerDirection, field.radius + centerSample.heightMeters);
  const radiusMeters = Math.max(CONTACT_SURFACE_LIMITS.minimumRadiusMeters,
    Math.min(CONTACT_SURFACE_LIMITS.maximumRadiusMeters, lease.radiusMeters));
  const segments = Math.max(2, Math.ceil(radiusMeters * 2 / lease.requiredCellMeters));
  if (segments > CONTACT_SURFACE_LIMITS.maximumSegments) {
    throw new RangeError('The requested contact resolution exceeds the bounded mesh budget.');
  }
  const cellMeters = radiusMeters * 2 / segments;
  const side = segments + 1;
  const vertices = new Float32Array(side * side * 3);
  const colors = new Float32Array(vertices.length);
  const indices = new Uint32Array(segments * segments * 6);
  const terrainPalette = createSurfaceTerrainPalette(field);
  // Keep first-sample/cache setup and bounded typed-array allocations out of
  // the first full grid batch. Workers simply drain this same yield sequence.
  yield;

  let batch = 0;
  for (let row = 0; row <= segments; row += 1) {
    const z = -radiusMeters + row * cellMeters;
    for (let column = 0; column <= segments; column += 1) {
      const x = -radiusMeters + column * cellMeters;
      const direction = contactDirectionAt(frame, field.radius, x, z);
      const sample = samplePlanetField(field, direction);
      if (!Number.isFinite(sample.heightMeters) || sample.color.some((channel) => !Number.isFinite(channel))) {
        throw new RangeError('The authoritative contact field returned a nonfinite sample.');
      }
      // Do not clamp signed desert/volcanic depressions to the ocean datum.
      const physical = scaleVec3(direction, field.radius + sample.heightMeters);
      const local = bodyFixedToContactLocal(frame, physical);
      const offset = (row * side + column) * 3;
      vertices[offset] = local.x;
      vertices[offset + 1] = local.y;
      vertices[offset + 2] = local.z;
      // The distant surface uses linear geological albedo, not the field's
      // raw display-space palette. Share that same body-fixed color policy.
      const color = sampleSurfaceTerrainColor(terrainPalette, field, sample, direction);
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
      if (++batch === CONTACT_SURFACE_GENERATION_BATCH_SIZE) { batch = 0; yield; }
    }
  }
  yield;

  // Reuse neighboring physical vertices for slope shading. This costs no
  // second heightfield pass, changes no collision triangle, and keeps the
  // existing transferable-buffer budget exactly unchanged.
  const originRadius = lengthVec3(frame.originBodyFixedMeters);
  batch = 0;
  for (let row = 0; row <= segments; row += 1) {
    for (let column = 0; column <= segments; column += 1) {
      const offset = (row * side + column) * 3;
      const left = (row * side + Math.max(0, column - 1)) * 3;
      const right = (row * side + Math.min(segments, column + 1)) * 3;
      const back = (Math.max(0, row - 1) * side + column) * 3;
      const front = (Math.min(segments, row + 1) * side + column) * 3;
      const dx = { x: vertices[right]! - vertices[left]!, y: vertices[right + 1]! - vertices[left + 1]!, z: vertices[right + 2]! - vertices[left + 2]! };
      const dz = { x: vertices[front]! - vertices[back]!, y: vertices[front + 1]! - vertices[back + 1]!, z: vertices[front + 2]! - vertices[back + 2]! };
      const normal = normalizeVec3(crossVec3(dz, dx));
      const radial = normalizeVec3({ x: vertices[offset]!, y: originRadius + vertices[offset + 1]!, z: vertices[offset + 2]! });
      const direction = contactDirectionAt(frame, field.radius, -radiusMeters + column * cellMeters, -radiusMeters + row * cellMeters);
      const color = shadeSurfaceTerrainFacet(terrainPalette, field, direction,
        1 - Math.abs(dotVec3(normal, radial)), [colors[offset]!, colors[offset + 1]!, colors[offset + 2]!]);
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
      if (++batch === CONTACT_SURFACE_GENERATION_BATCH_SIZE) { batch = 0; yield; }
    }
  }
  yield;

  let index = 0;
  batch = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * side + column;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      // x=east, z=north: this winding points toward positive local y.
      indices[index++] = a;
      indices[index++] = c;
      indices[index++] = b;
      indices[index++] = b;
      indices[index++] = c;
      indices[index++] = d;
      if (++batch === CONTACT_SURFACE_GENERATION_BATCH_SIZE) { batch = 0; yield; }
    }
  }
  yield;
  let sourceFlows = options.sourceFlows;
  if (sourceFlows == null) {
    const region = yield* createSurfaceFlowRegionTask(field, {
      centerDirection, patchSizeMeters: Math.max(32_000, radiusMeters * 2), maxInstances: 160,
    });
    sourceFlows = region.flows;
  }
  // The small bounded lattice/immutable descriptor assembly stays separate
  // from both the final index batch and a fallback flow-region sample.
  yield;
  const features = buildContactFeatures(field, centerDirection, radiusMeters, { ...options, sourceFlows });
  const riverHeading = sourceFlows.find((flow) => flow.kind === 'river' && flow.appearance !== 'cascade')?.headingBodyFixed;
  const lavaHeading = sourceFlows.find((flow) => flow.kind === 'lava')?.headingBodyFixed;
  return Object.freeze({
    id: `${lease.bodyId}:${lease.id}:${lease.token}`,
    bodyId: lease.bodyId,
    leaseId: lease.id,
    token: lease.token,
    fieldSeed: field.seed,
    fieldVersion: field.generatorVersion,
    bodyRadiusMeters: field.radius,
    centerDirection: Object.freeze(centerDirection),
    ...frame,
    radiusMeters,
    cellMeters,
    segments,
    vertices,
    colors,
    indices,
    solids: features.solids,
    flows: features.flows,
    flowOriginBodyFixedMeters: Object.freeze({ ...(options.sourceFlowOriginBodyFixedMeters ?? scaleVec3(centerDirection, field.radius)) }),
    flowReferenceDirections: Object.freeze({ ...(riverHeading ? { river: riverHeading } : {}), ...(lavaHeading ? { lava: lavaHeading } : {}) }),
    byteLength: vertices.byteLength + colors.byteLength + indices.byteLength,
  });
}

/** Native workers and deterministic fixtures drain the exact same physical producer. */
export function buildContactSurfaceGeneration(
  field: PlanetField,
  lease: ContactLease,
  options: ContactGeometryOptions = {},
): ContactSurfaceGeneration {
  const task = createContactSurfaceGenerationTask(field, lease, options);
  for (;;) {
    const step = task.next();
    if (step.done) return step.value;
  }
}

export function isValidContactGeneration(generation: ContactSurfaceGeneration): boolean {
  const side = generation.segments + 1;
  const finiteVector = (value: Readonly<Vec3>): boolean => Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
  const basisValid = (x: Readonly<Vec3>, y: Readonly<Vec3>, z: Readonly<Vec3>): boolean =>
    finiteVector(x) && finiteVector(y) && finiteVector(z) &&
    Math.abs(lengthVec3(x) - 1) < 1e-5 && Math.abs(lengthVec3(y) - 1) < 1e-5 && Math.abs(lengthVec3(z) - 1) < 1e-5 &&
    Math.abs(dotVec3(x, y)) < 1e-5 && Math.abs(dotVec3(y, z)) < 1e-5 && dotVec3(crossVec3(x, y), z) > 0.99999;
  if (!Number.isInteger(generation.segments) || generation.segments < 2 || generation.segments > CONTACT_SURFACE_LIMITS.maximumSegments ||
    !Number.isFinite(generation.cellMeters) || generation.cellMeters <= 0 ||
    generation.vertices.length !== side * side * 3 || generation.colors.length !== generation.vertices.length ||
    generation.indices.length !== generation.segments * generation.segments * 6 ||
    !finiteVector(generation.originBodyFixedMeters) || !finiteVector(generation.centerDirection) ||
    !basisValid(generation.eastBodyFixed, generation.upBodyFixed, generation.northBodyFixed) ||
    !Number.isFinite(generation.bodyRadiusMeters) || generation.bodyRadiusMeters <= 0 ||
    !Number.isFinite(generation.radiusMeters) || generation.radiusMeters <= 0 ||
    Math.abs(generation.cellMeters * generation.segments - generation.radiusMeters * 2) > 1e-5 ||
    generation.solids.length > 48 || generation.flows.length > 64) return false;
  for (const value of generation.vertices) if (!Number.isFinite(value)) return false;
  for (const value of generation.colors) if (!Number.isFinite(value)) return false;
  for (const index of generation.indices) if (index >= side * side) return false;
  for (const solid of generation.solids) {
    if (!finiteVector(solid.centerBodyFixedMeters) || !finiteVector(solid.halfExtentsMeters) ||
      solid.halfExtentsMeters.x <= 0 || solid.halfExtentsMeters.y <= 0 || solid.halfExtentsMeters.z <= 0 ||
      !basisValid(solid.rightBodyFixed, solid.upBodyFixed, solid.forwardBodyFixed)) return false;
  }
  for (const flow of generation.flows) {
    if (!isValidSurfaceFlowDescriptor(flow, generation.bodyRadiusMeters)) return false;
  }
  return true;
}

function localVertex(generation: ContactSurfaceGeneration, index: number): Vec3 {
  const offset = index * 3;
  return {
    x: generation.vertices[offset]!,
    y: generation.vertices[offset + 1]!,
    z: generation.vertices[offset + 2]!,
  };
}

/** Radial ray/triangle intersection in a bounded tangent frame (all math float64). */
function intersectTriangle(
  origin: Readonly<Vec3>,
  direction: Readonly<Vec3>,
  a: Readonly<Vec3>,
  b: Readonly<Vec3>,
  c: Readonly<Vec3>,
): { distance: number; normal: Vec3 } | null {
  const ab = subVec3(b, a);
  const ac = subVec3(c, a);
  const p = crossVec3(direction, ac);
  const determinant = dotVec3(ab, p);
  if (Math.abs(determinant) < 1e-10) return null;
  const inverse = 1 / determinant;
  const relative = subVec3(origin, a);
  const u = dotVec3(relative, p) * inverse;
  if (u < -1e-5 || u > 1.00001) return null;
  const q = crossVec3(relative, ab);
  const v = dotVec3(direction, q) * inverse;
  if (v < -1e-5 || u + v > 1.00001) return null;
  const distance = dotVec3(ac, q) * inverse;
  return distance >= 0 ? { distance, normal: normalizeVec3(crossVec3(ab, ac)) } : null;
}

/** Samples the actual committed triangles, not a second higher-resolution height function. */
export function sampleContactGeneration(
  generation: ContactSurfaceGeneration,
  directionInput: Readonly<Vec3>,
): ContactTriangleSample | null {
  const grid = contactGridCoordinates(generation, directionInput);
  if (!grid || Math.abs(grid.x) > generation.radiusMeters + 1e-5 || Math.abs(grid.z) > generation.radiusMeters + 1e-5) return null;
  const column = Math.max(0, Math.min(generation.segments - 1,
    Math.floor((grid.x + generation.radiusMeters) / generation.cellMeters)));
  const row = Math.max(0, Math.min(generation.segments - 1,
    Math.floor((grid.z + generation.radiusMeters) / generation.cellMeters)));
  const radial = normalizeVec3(directionInput);
  const direction = {
    x: dotVec3(radial, generation.eastBodyFixed),
    y: dotVec3(radial, generation.upBodyFixed),
    z: dotVec3(radial, generation.northBodyFixed),
  };
  const origin = bodyFixedToContactLocal(generation, { x: 0, y: 0, z: 0 });
  const firstTriangle = (row * generation.segments + column) * 2;
  for (let triangle = firstTriangle; triangle <= firstTriangle + 1; triangle += 1) {
    const offset = triangle * 3;
    const hit = intersectTriangle(origin, direction,
      localVertex(generation, generation.indices[offset]!),
      localVertex(generation, generation.indices[offset + 1]!),
      localVertex(generation, generation.indices[offset + 2]!),
    );
    if (!hit) continue;
    const normal = normalizeVec3(addVec3(
      scaleVec3(generation.eastBodyFixed, hit.normal.x),
      addVec3(scaleVec3(generation.upBodyFixed, hit.normal.y), scaleVec3(generation.northBodyFixed, hit.normal.z)),
    ));
    return {
      pointBodyFixedMeters: scaleVec3(radial, hit.distance),
      normalBodyFixed: dotVec3(normal, radial) < 0 ? scaleVec3(normal, -1) : normal,
      groundRadiusMeters: hit.distance,
      triangleIndex: triangle,
    };
  }
  return null;
}
