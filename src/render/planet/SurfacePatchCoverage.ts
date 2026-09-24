import { Vector3 } from 'three';
import { positionLocal, uniform } from 'three/tsl';

import {
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../../core/Vec3';

export interface SurfacePatchCoverageInput {
  /** Prefer the actual child's published, already-normalized centerDirection. */
  readonly centerDirection: Readonly<Vec3>;
  readonly bodyRadiusMeters: number;
  /** Half of the child's gnomonic grid width, in real meters. */
  readonly halfWidthMeters: number;
  readonly cellMeters: number;
  /** May increase, but cannot reduce, the two-cell parent/child overlap. */
  readonly overlapMeters?: number;
}

/** Plain body-fixed geometry metadata, not a contact generation or readiness claim. */
export interface SurfacePatchCoverage {
  readonly centerDirection: Readonly<Vec3>;
  readonly tangentBodyFixed: Readonly<Vec3>;
  readonly bitangentBodyFixed: Readonly<Vec3>;
  readonly bodyRadiusMeters: number;
  readonly halfWidthMeters: number;
  readonly cellMeters: number;
  readonly overlapMeters: number;
  readonly cutoutHalfWidthMeters: number;
}

export interface SurfacePatchCoverageCoordinates {
  readonly xMeters: number;
  readonly yMeters: number;
  /** Signed distance along the child's radial axis; always positive here. */
  readonly radialMeters: number;
}

export interface SurfacePatchCoverageMaskOptions {
  /** The mesh local origin in the same body-fixed meter frame as the child. */
  readonly originBodyFixedMeters: Readonly<Vec3>;
  /** Local axes are body-fixed XYZ; only the unit scale and origin differ. */
  readonly metersPerLocalUnit: number;
  /** Same-level replacements need the actual square, not a parent/child inset. */
  readonly fullFootprint?: boolean;
}

/** Match SurfacePatch.coordinateDirection and its exact polar reference-axis switch. */
export function createSurfacePatchCoverage(input: SurfacePatchCoverageInput): SurfacePatchCoverage | undefined {
  if (!finiteVector(input.centerDirection) || !positiveFinite(input.bodyRadiusMeters) ||
      !positiveFinite(input.halfWidthMeters) || !positiveFinite(input.cellMeters) ||
      (input.overlapMeters !== undefined && (!Number.isFinite(input.overlapMeters) || input.overlapMeters < 0))) return undefined;
  const centerLength = lengthVec3(input.centerDirection);
  if (!positiveFinite(centerLength)) return undefined;
  // Re-normalizing a published unit vector can move exactly |y|=.9 across
  // SurfacePatch's reference-axis switch by one ULP and rotate the square.
  // Preserve that source value; normalize other inputs like Vector3 does.
  let centerDirection = { ...input.centerDirection };
  if (Math.abs(centerLength - 1) > Number.EPSILON * 4) {
    const sourceLength = Math.sqrt(dotVec3(input.centerDirection, input.centerDirection));
    if (!positiveFinite(sourceLength)) return undefined;
    centerDirection = scaleVec3(input.centerDirection, 1 / sourceLength);
  }
  const reference = Math.abs(centerDirection.y) > 0.9
    ? { x: 0, y: 0, z: 1 }
    : { x: 0, y: 1, z: 0 };
  const tangentBodyFixed = normalizeVec3(crossVec3(reference, centerDirection));
  const bitangentBodyFixed = normalizeVec3(crossVec3(centerDirection, tangentBodyFixed));
  const overlapMeters = Math.max(input.cellMeters * 2, input.overlapMeters ?? 0);
  const cutoutHalfWidthMeters = Math.max(0, input.halfWidthMeters - overlapMeters);
  if (!finiteVector(centerDirection) || !finiteVector(tangentBodyFixed) || !finiteVector(bitangentBodyFixed) ||
      !Number.isFinite(overlapMeters) || !Number.isFinite(input.halfWidthMeters / input.bodyRadiusMeters)) return undefined;
  return freezeCoverage({
    centerDirection,
    tangentBodyFixed,
    bitangentBodyFixed,
    bodyRadiusMeters: input.bodyRadiusMeters,
    halfWidthMeters: input.halfWidthMeters,
    cellMeters: input.cellMeters,
    overlapMeters,
    cutoutHalfWidthMeters,
  });
}

/** Return an immutable plain copy without retaining any caller-owned vectors. */
export function cloneSurfacePatchCoverage(coverage: SurfacePatchCoverage): SurfacePatchCoverage {
  return freezeCoverage(coverage);
}

/** Invert the actual radial grid; height above or below the reference sphere cancels. */
export function surfacePatchCoverageCoordinates(
  coverage: SurfacePatchCoverage,
  bodyFixedPositionMeters: Readonly<Vec3>,
): SurfacePatchCoverageCoordinates | undefined {
  const valid = validatedCoverage(coverage);
  if (!valid || !finiteVector(bodyFixedPositionMeters)) return undefined;
  const radialMeters = dotVec3(bodyFixedPositionMeters, valid.centerDirection);
  if (!positiveFinite(radialMeters)) return undefined;
  const projection = valid.bodyRadiusMeters / radialMeters;
  const xMeters = dotVec3(bodyFixedPositionMeters, valid.tangentBodyFixed) * projection;
  const yMeters = dotVec3(bodyFixedPositionMeters, valid.bitangentBodyFixed) * projection;
  return Number.isFinite(xMeters) && Number.isFinite(yMeters)
    ? { xMeters, yMeters, radialMeters }
    : undefined;
}

/** Full closed child footprint by default; use cutout:true for the parent's strict interior mask. */
export function surfacePatchCoverageContains(
  coverage: SurfacePatchCoverage,
  bodyFixedPositionMeters: Readonly<Vec3>,
  options: { readonly cutout?: boolean } = {},
): boolean {
  const valid = validatedCoverage(coverage);
  if (!valid || !finiteVector(bodyFixedPositionMeters)) return false;
  const radialMeters = dotVec3(bodyFixedPositionMeters, valid.centerDirection);
  const halfWidth = options.cutout ? valid.cutoutHalfWidthMeters : valid.halfWidthMeters;
  if (!positiveFinite(radialMeters) || halfWidth <= 0) return false;
  const bound = radialMeters * (halfWidth / valid.bodyRadiusMeters);
  const x = Math.abs(dotVec3(bodyFixedPositionMeters, valid.tangentBodyFixed));
  const y = Math.abs(dotVec3(bodyFixedPositionMeters, valid.bitangentBodyFixed));
  if (!Number.isFinite(bound) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return options.cutout ? x < bound && y < bound : x <= bound && y <= bound;
}

/**
 * One stable TSL visibility node. Moving/replacing a child changes uniforms,
 * never parent vertices, material graph identity, or collision authority.
 */
export function createSurfacePatchCoverageMask() {
  const center = uniform(new Vector3());
  const radialAxis = uniform(new Vector3(0, 1, 0));
  const tangent = uniform(new Vector3(-1, 0, 0));
  const bitangent = uniform(new Vector3(0, 0, 1));
  const referenceRadius = uniform(1);
  const angularHalfWidth = uniform(0);
  const enabled = uniform(0);
  const relative = positionLocal.sub(center);
  const facing = referenceRadius.add(relative.dot(radialAxis));
  const bound = facing.mul(angularHalfWidth);
  // Cross multiplication is the exact gnomonic inverse on the front
  // hemisphere. No reciprocal/clamped denominator can fold the back side in.
  const inside = enabled.greaterThan(0.5)
    .and(facing.greaterThan(0))
    .and(relative.dot(tangent).abs().lessThan(bound))
    .and(relative.dot(bitangent).abs().lessThan(bound));
  const node = inside.not();
  let activeCoverage: SurfacePatchCoverage | undefined;

  const disable = (): void => {
    activeCoverage = undefined;
    enabled.value = 0;
    center.value.set(0, 0, 0);
    radialAxis.value.set(0, 1, 0);
    tangent.value.set(-1, 0, 0);
    bitangent.value.set(0, 0, 1);
    referenceRadius.value = 1;
    angularHalfWidth.value = 0;
  };

  return {
    node,
    get coverage(): SurfacePatchCoverage | undefined { return activeCoverage; },
    set(coverage: SurfacePatchCoverage | undefined, options: SurfacePatchCoverageMaskOptions): void {
      const valid = coverage ? validatedCoverage(coverage) : undefined;
      if (!valid || !finiteVector(options.originBodyFixedMeters) || !positiveFinite(options.metersPerLocalUnit)) {
        disable();
        return;
      }
      const scale = options.metersPerLocalUnit;
      const localCenter = scaleVec3(subVec3(
        scaleVec3(valid.centerDirection, valid.bodyRadiusMeters), options.originBodyFixedMeters,
      ), 1 / scale);
      const localRadius = valid.bodyRadiusMeters / scale;
      const halfWidth = options.fullFootprint ? valid.halfWidthMeters : valid.cutoutHalfWidthMeters;
      const angularWidth = halfWidth / valid.bodyRadiusMeters;
      // Bad scales must fail open instead of uploading NaN/Infinity or a
      // vanished float32 reference radius into a real parent's fragment mask.
      if (!finiteFloat32Vector(localCenter) || !positiveFinite(Math.fround(localRadius)) ||
          !Number.isFinite(Math.fround(angularWidth))) {
        disable();
        return;
      }
      center.value.set(localCenter.x, localCenter.y, localCenter.z);
      radialAxis.value.set(valid.centerDirection.x, valid.centerDirection.y, valid.centerDirection.z);
      tangent.value.set(valid.tangentBodyFixed.x, valid.tangentBodyFixed.y, valid.tangentBodyFixed.z);
      bitangent.value.set(valid.bitangentBodyFixed.x, valid.bitangentBodyFixed.y, valid.bitangentBodyFixed.z);
      referenceRadius.value = localRadius;
      angularHalfWidth.value = angularWidth;
      activeCoverage = valid;
      enabled.value = Math.fround(angularWidth) > 0 ? 1 : 0;
    },
    /** CPU mirror of the exact local presentation uniforms, not a terrain query. */
    isVisibleAtLocal(position: Readonly<Vec3>): boolean {
      if (enabled.value <= 0.5 || !finiteVector(position)) return true;
      const local = subVec3(position, center.value);
      const radial = referenceRadius.value + dotVec3(local, radialAxis.value);
      const localBound = radial * angularHalfWidth.value;
      if (!positiveFinite(radial) || !Number.isFinite(localBound)) return true;
      return Math.abs(dotVec3(local, tangent.value)) >= localBound ||
        Math.abs(dotVec3(local, bitangent.value)) >= localBound;
    },
  };
}

export type SurfacePatchCoverageMask = ReturnType<typeof createSurfacePatchCoverageMask>;

/** Six resident local layers and, at most, one retiring recenter generation. */
export const MAX_OPAQUE_SURFACE_COVERAGES = 7;

/**
 * One bounded union of genuinely opaque local footprints. The globe and its
 * ocean share this contract; neither may disappear outside published ground.
 * Updating coverage changes uniforms only, including when workers finish out
 * of order or a layer recenters.
 */
export function createSurfacePatchCoverageSetMask(maximum = MAX_OPAQUE_SURFACE_COVERAGES) {
  const limit = Number.isFinite(maximum)
    ? Math.max(1, Math.min(8, Math.floor(maximum))) : MAX_OPAQUE_SURFACE_COVERAGES;
  const masks = Array.from({ length: limit }, () => createSurfacePatchCoverageMask());
  const node = masks.slice(1).reduce((combined, mask) => combined.and(mask.node), masks[0]!.node);
  return {
    node,
    get count(): number { return masks.reduce((total, mask) => total + Number(Boolean(mask.coverage)), 0); },
    set(coverages: readonly SurfacePatchCoverage[], options: SurfacePatchCoverageMaskOptions): void {
      for (let index = 0; index < masks.length; index += 1) masks[index]!.set(coverages[index], options);
    },
    isVisibleAtLocal(position: Readonly<Vec3>): boolean {
      return masks.every((mask) => mask.isVisibleAtLocal(position));
    },
  };
}

export type SurfacePatchCoverageSetMask = ReturnType<typeof createSurfacePatchCoverageSetMask>;

function freezeCoverage(coverage: SurfacePatchCoverage): SurfacePatchCoverage {
  return Object.freeze({
    ...coverage,
    centerDirection: freezeVector(coverage.centerDirection),
    tangentBodyFixed: freezeVector(coverage.tangentBodyFixed),
    bitangentBodyFixed: freezeVector(coverage.bitangentBodyFixed),
  });
}

function freezeVector(value: Readonly<Vec3>): Readonly<Vec3> {
  // Canonical positive zero survives a JSON round trip at either pole.
  return Object.freeze({ x: value.x === 0 ? 0 : value.x, y: value.y === 0 ? 0 : value.y, z: value.z === 0 ? 0 : value.z });
}

/** Accept serialized plain descriptors, but never trust altered axes or unsafe derived bounds. */
function validatedCoverage(coverage: SurfacePatchCoverage): SurfacePatchCoverage | undefined {
  if (!coverage || !finiteVector(coverage.centerDirection) || !finiteVector(coverage.tangentBodyFixed) ||
      !finiteVector(coverage.bitangentBodyFixed)) return undefined;
  const canonical = createSurfacePatchCoverage(coverage);
  if (!canonical || !sameVector(coverage.centerDirection, canonical.centerDirection) ||
      !sameVector(coverage.tangentBodyFixed, canonical.tangentBodyFixed) ||
      !sameVector(coverage.bitangentBodyFixed, canonical.bitangentBodyFixed) ||
      !sameNumber(coverage.overlapMeters, canonical.overlapMeters) ||
      !sameNumber(coverage.cutoutHalfWidthMeters, canonical.cutoutHalfWidthMeters)) return undefined;
  return canonical;
}

function positiveFinite(value: number): boolean { return Number.isFinite(value) && value > 0; }

function finiteVector(value: Readonly<Vec3> | undefined): value is Readonly<Vec3> {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z));
}

function finiteFloat32Vector(value: Readonly<Vec3>): boolean {
  return Number.isFinite(Math.fround(value.x)) && Number.isFinite(Math.fround(value.y)) && Number.isFinite(Math.fround(value.z));
}

function sameVector(left: Readonly<Vec3>, right: Readonly<Vec3>): boolean {
  return Math.abs(left.x - right.x) <= 1e-10 && Math.abs(left.y - right.y) <= 1e-10 && Math.abs(left.z - right.z) <= 1e-10;
}

function sameNumber(left: number, right: number): boolean {
  return Number.isFinite(left) && Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-12);
}
