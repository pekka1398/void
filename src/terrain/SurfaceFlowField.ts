import { Vector3 } from 'three';

import { hashCoordinates, hashUnit, samplePlanetClimate, samplePlanetField, type PlanetField, type PlanetSurfaceSample } from '../fields';
import type { Vec3 } from '../core/Vec3';
import type { ContactFlowDescriptor } from './ContactGeometry';
import { isValidSurfaceFlowDescriptor, surfaceFlowContains } from './SurfaceFlowGeometry';

export interface SurfaceFlowRegionOptions {
  centerDirection: Readonly<Vec3>;
  patchSizeMeters: number;
  maxInstances?: number;
}

export interface SurfaceFlowRegion {
  readonly id: string;
  /** Liquid topology is versioned separately from the unchanged physical planet field. */
  readonly flowVersion: number;
  readonly fieldSeed: number;
  readonly fieldVersion: number;
  readonly bodyRadiusMeters: number;
  readonly centerDirection: Readonly<Vec3>;
  readonly patchSizeMeters: number;
  readonly maximumInstances: number;
  readonly flows: readonly ContactFlowDescriptor[];
}

const UP = new Vector3(0, 1, 0);
const GOLDEN_ANGLE = 2.399_963_229_728_653;
export const SURFACE_FLOW_GENERATOR_VERSION = 2;
export const MAX_SURFACE_RIVER_SEGMENTS = 34;
export const MAX_SURFACE_LAVA_SEGMENTS = 30;
export const SURFACE_RIVER_SECTION_METERS = 132;
/** Small field/facet tolerance only; never bridge a genuinely uphill reach. */
export const MAX_SURFACE_RIVER_UPHILL_METERS = 0.5;
const clamp = (value: number, minimum = 0, maximum = 1): number => Math.min(maximum, Math.max(minimum, value));
const plain = (value: Vector3): Readonly<Vec3> => Object.freeze({ x: value.x, y: value.y, z: value.z });

function regionIdentity(fieldSeed: number, fieldVersion: number, center: Readonly<Vec3>,
  patchSizeMeters: number, maximumInstances: number): string {
  return `flow-v${SURFACE_FLOW_GENERATOR_VERSION}:${fieldSeed}:${fieldVersion}:${Math.round(center.x * 1e9)},${Math.round(center.y * 1e9)},${Math.round(center.z * 1e9)}:${Math.round(patchSizeMeters)}:${maximumInstances}`;
}

/** Reject stale topology epochs and malformed worker hazards before pinning them. */
export function isValidSurfaceFlowRegion(
  value: unknown,
  field?: Pick<PlanetField, 'seed' | 'generatorVersion' | 'radius'>,
): value is SurfaceFlowRegion {
  if (!value || typeof value !== 'object') return false;
  const region = value as Partial<SurfaceFlowRegion>;
  const center = region.centerDirection;
  if (region.flowVersion !== SURFACE_FLOW_GENERATOR_VERSION || !Number.isInteger(region.fieldSeed) ||
    !Number.isInteger(region.fieldVersion) || !center ||
    ![center.x, center.y, center.z, region.bodyRadiusMeters, region.patchSizeMeters].every(Number.isFinite) ||
    Math.abs(Math.hypot(center.x, center.y, center.z) - 1) > 1e-5 ||
    !(region.bodyRadiusMeters! > 0) || !(region.patchSizeMeters! > 0) ||
    !Number.isInteger(region.maximumInstances) || region.maximumInstances! < 0 || region.maximumInstances! > 160 ||
    region.id !== regionIdentity(region.fieldSeed!, region.fieldVersion!, center, region.patchSizeMeters!, region.maximumInstances!) ||
    !Array.isArray(region.flows) || region.flows.length > 64) return false;
  if (field && (region.fieldSeed !== field.seed || region.fieldVersion !== field.generatorVersion ||
    Math.abs(region.bodyRadiusMeters! - field.radius) > 1e-6)) return false;
  const seen = new Set<string>();
  for (const flow of region.flows) {
    if (!isValidSurfaceFlowDescriptor(flow, region.bodyRadiusMeters) ||
      !flow.id.startsWith(`${region.id}:`) || seen.has(flow.id)) return false;
    seen.add(flow.id);
  }
  return true;
}

/** Structured cloning drops freezes; restore the validated hazard epoch once on receipt. */
export function freezeSurfaceFlowRegion(region: SurfaceFlowRegion): SurfaceFlowRegion {
  for (const flow of region.flows) {
    Object.freeze(flow.centerDirection);
    Object.freeze(flow.headingBodyFixed);
    for (const corner of flow.cornersBodyFixedMeters) Object.freeze(corner);
    Object.freeze(flow.cornersBodyFixedMeters);
    Object.freeze(flow);
  }
  Object.freeze(region.centerDirection);
  Object.freeze(region.flows);
  return Object.freeze(region);
}

/**
 * Shared visible river/lava construction, independent of the renderer.
 * A region is immutable and can be pinned by both contact leases and distant
 * surface presentation. No camera, scene graph, or visibility is consulted.
 */
export function* createSurfaceFlowRegionTask(
  field: PlanetField,
  options: SurfaceFlowRegionOptions,
): Generator<void, SurfaceFlowRegion, void> {
  const center = new Vector3(options.centerDirection.x, options.centerDirection.y, options.centerDirection.z).normalize();
  const maximumInstances = Math.max(0, Math.min(160, Math.round(options.maxInstances ?? 112)));
  const id = regionIdentity(field.seed, field.generatorVersion, center, options.patchSizeMeters, maximumInstances);
  const flows: ContactFlowDescriptor[] = [];
  let rivers = 0;
  let lava = 0;
  let cascades = 0;
  const sample = (direction: Vector3): PlanetSurfaceSample => samplePlanetField(field, direction);
  const physical = (direction: Vector3, heightMeters: number): Readonly<Vec3> => plain(direction.clone().multiplyScalar(field.radius + heightMeters));

  const appendCascade = (dryDirection: Vector3, heading: Vector3, sideways: Vector3, halfWidthMeters: number, strength: number, variation: number): void => {
    if (cascades >= 5) return;
    let previousDirection = dryDirection;
    let previousSample = sample(previousDirection);
    let wetDirection: Vector3 | undefined;
    for (let step = 1; step <= 9; step += 1) {
      const candidate = dryDirection.clone().addScaledVector(heading, step * 82 / field.radius).normalize();
      const current = sample(candidate);
      if (current.ocean) { wetDirection = candidate; break; }
      if ((current.riverStrength ?? 0) <= 0) return;
      previousDirection = candidate;
      previousSample = current;
    }
    if (!wetDirection || previousSample.heightMeters < 1.1) return;
    const startLeft = previousDirection.clone().addScaledVector(sideways, -halfWidthMeters * 0.52 / field.radius).normalize();
    const startRight = previousDirection.clone().addScaledVector(sideways, halfWidthMeters * 0.52 / field.radius).normalize();
    const endLeft = wetDirection.clone().addScaledVector(sideways, -halfWidthMeters * 0.41 / field.radius).normalize();
    const endRight = wetDirection.clone().addScaledVector(sideways, halfWidthMeters * 0.41 / field.radius).normalize();
    const a = sample(startLeft); const b = sample(startRight); const c = sample(endLeft); const d = sample(endRight);
    if (a.ocean || b.ocean || !c.ocean || !d.ocean || (a.riverStrength ?? 0) <= 0 || (b.riverStrength ?? 0) <= 0) return;
    const midpoint = previousDirection.clone().add(wetDirection).normalize();
    flows.push(Object.freeze({
      id: `${id}:cascade:${cascades++}`, kind: 'river', appearance: 'cascade',
      centerDirection: plain(midpoint), headingBodyFixed: plain(heading),
      halfLengthMeters: previousDirection.distanceTo(wetDirection) * field.radius * 0.5,
      halfWidthMeters: halfWidthMeters * 0.52, strength, variation,
      cornersBodyFixedMeters: Object.freeze([
        physical(startLeft, a.heightMeters + 0.75), physical(startRight, b.heightMeters + 0.75),
        physical(endLeft, 0.32), physical(endRight, 0.32),
      ]) as unknown as ContactFlowDescriptor['cornersBodyFixedMeters'],
    }));
  };

  // Lava keeps its established physical footprint in this river-only revision.
  const appendLava = (direction: Vector3, current: PlanetSurfaceSample, variation: number, pathHeading?: Vector3, widthScale = 1): void => {
    if (lava >= MAX_SURFACE_LAVA_SEGMENTS) return;
    const strength = current.lavaStrength ?? 0;
    const heading = pathHeading?.clone() ??
      new Vector3().crossVectors(direction, Math.abs(direction.y) > 0.9 ? new Vector3(0, 0, 1) : UP);
    heading.addScaledVector(direction, -heading.dot(direction));
    if (heading.lengthSq() < 0.00001) return;
    heading.normalize();
    const sideways = new Vector3().crossVectors(direction, heading).normalize();
    const lengthMeters = 158 + strength * 98 + variation * 28;
    const halfLengthMeters = lengthMeters * 0.48;
    const halfWidthMeters = (16 + strength * 16) * widthScale;
    const directions = [
      direction.clone().addScaledVector(heading, -halfLengthMeters / field.radius).addScaledVector(sideways, -halfWidthMeters / field.radius).normalize(),
      direction.clone().addScaledVector(heading, -halfLengthMeters / field.radius).addScaledVector(sideways, halfWidthMeters / field.radius).normalize(),
      direction.clone().addScaledVector(heading, halfLengthMeters / field.radius).addScaledVector(sideways, -halfWidthMeters / field.radius).normalize(),
      direction.clone().addScaledVector(heading, halfLengthMeters / field.radius).addScaledVector(sideways, halfWidthMeters / field.radius).normalize(),
    ];
    const samples = directions.map(sample);
    if (samples.some((corner) => corner.ocean || corner.heightMeters <= 0 ||
      (corner.lavaStrength ?? 0) <= 0)) return;
    const ordinal = lava++;
    flows.push(Object.freeze({
      id: `${id}:lava:${ordinal}`, kind: 'lava', appearance: 'channel',
      centerDirection: plain(direction), headingBodyFixed: plain(heading), halfLengthMeters, halfWidthMeters,
      strength, variation,
      cornersBodyFixedMeters: Object.freeze(directions.map((corner, index) => physical(corner,
        samples[index]!.heightMeters + 3.6))) as unknown as ContactFlowDescriptor['cornersBodyFixedMeters'],
    }));
  };

  interface RiverRow {
    readonly halfWidthMeters: number;
    readonly meanHeightMeters: number;
    readonly corners: readonly [Readonly<Vec3>, Readonly<Vec3>];
  }
  interface RiverSection {
    readonly direction: Vector3;
    readonly heading: Vector3;
    readonly sample: PlanetSurfaceSample;
    readonly variation: number;
  }

  /**
   * The previous channel used overlapping, separately rotated rectangles.
   * A row is now sampled once and shared verbatim by both neighboring quads.
   * Shorter sections and gradual bank widths retain the intended faceted
   * style without the projecting sawtooth corners at every river bend.
   */
  const appendRiverRun = function* (
    runCenter: Vector3,
    initial: PlanetSurfaceSample,
    requestedSections: number,
    runSeed: number,
  ): Generator<void, void, void> {
    const limit = Math.min(requestedSections, MAX_SURFACE_RIVER_SEGMENTS - rivers);
    if (limit <= 0 || !initial.riverDirection) return;
    // A later local run may approach an existing channel but must not lay a
    // second transparent rectangle over it. Exclude only previously prepared
    // runs; adjacent sections within this run deliberately share their edge.
    const earlierChannels = flows.filter((flow) => flow.kind === 'river' && flow.appearance !== 'cascade');
    const heading = new Vector3().copy(initial.riverDirection);
    heading.addScaledVector(runCenter, -heading.dot(runCenter));
    if (heading.lengthSq() < 0.00001) return;
    heading.normalize();
    const sideways = new Vector3().crossVectors(runCenter, heading).normalize();
    const broadPhase = hashUnit(runSeed ^ 0x68bc_21eb) * Math.PI * 2;
    const finePhase = hashUnit(runSeed ^ 0x41d2_908f) * Math.PI * 2;
    const lateralAt = (distance: number): number =>
      130 * (Math.sin(distance / 690 + broadPhase) - Math.sin(broadPhase)) +
      38 * (Math.sin(distance / 235 + finePhase) - Math.sin(finePhase));
    const directionAt = (distance: number): Vector3 => runCenter.clone()
      .addScaledVector(heading, distance / field.radius)
      .addScaledVector(sideways, lateralAt(distance) / field.radius).normalize();
    const headingAt = (distance: number, direction: Vector3): Vector3 => {
      const value = directionAt(distance + 24).sub(directionAt(distance - 24));
      return value.addScaledVector(direction, -value.dot(direction)).normalize();
    };
    const widthAt = (distance: number, strength: number): number => (8 + strength * 14) *
      clamp(0.94 + Math.sin(distance / 470 + broadPhase) * 0.1 +
        Math.sin(distance / 210 + finePhase) * 0.045, 0.79, 1.1);
    const makeRow = (distance: number, taper = 1): RiverRow | null => {
      const direction = directionAt(distance);
      const current = samplePlanetClimate(field, direction);
      const strength = current.riverStrength ?? 0;
      if (current.ocean || current.heightMeters <= 0 || strength <= 0) return null;
      const rowHeading = headingAt(distance, direction);
      const across = new Vector3().crossVectors(direction, rowHeading).normalize();
      const halfWidthMeters = Math.max(2.5, widthAt(distance, strength) * taper);
      const left = direction.clone().addScaledVector(across, -halfWidthMeters / field.radius).normalize();
      const right = direction.clone().addScaledVector(across, halfWidthMeters / field.radius).normalize();
      const leftSample = samplePlanetClimate(field, left);
      const rightSample = samplePlanetClimate(field, right);
      if ([leftSample, rightSample].some((bank) => bank.ocean || bank.heightMeters <= 0 ||
        (bank.riverStrength ?? 0) <= 0)) return null;
      return { halfWidthMeters, meanHeightMeters: (leftSample.heightMeters + rightSample.heightMeters) * 0.5,
        corners: Object.freeze([physical(left, leftSample.heightMeters + 2.8),
          physical(right, rightSample.heightMeters + 2.8)]) };
    };

    const rows: Array<RiverRow | null> = [];
    const sections: Array<RiverSection | null> = [];
    for (let index = 0; index <= limit; index += 1) {
      // At most three climate samples in one cooperative unit.
      yield;
      rows.push(makeRow((index - limit * 0.5) * SURFACE_RIVER_SECTION_METERS));
    }
    for (let index = 0; index < limit; index += 1) {
      yield;
      const distance = (index - (limit - 1) * 0.5) * SURFACE_RIVER_SECTION_METERS;
      const direction = directionAt(distance);
      const current = sample(direction);
      const strength = current.riverStrength ?? 0;
      const pathHeading = headingAt(distance, direction);
      const downhill = current.riverDirection;
      const agreesWithDownhill = downhill && pathHeading.dot(new Vector3().copy(downhill)) > 0.72;
      const overlapsEarlierRun = earlierChannels.some((flow) =>
        surfaceFlowContains(field.radius, flow, direction, SURFACE_RIVER_SECTION_METERS * 0.75));
      const back = rows[index]; const front = rows[index + 1];
      const descends = back && front &&
        front.meanHeightMeters <= back.meanHeightMeters + MAX_SURFACE_RIVER_UPHILL_METERS;
      // Never bridge a rejected field section, actual ocean, or uphill turn.
      const valid = descends && !current.ocean && current.heightMeters > 0 &&
        strength > 0.3 && agreesWithDownhill && !overlapsEarlierRun;
      const seed = hashCoordinates(Math.round(direction.x * 65_536), Math.round(direction.y * 65_536),
        Math.round(direction.z * 65_536), runSeed ^ 0x04b1_9f37);
      sections.push(valid ? { direction, heading: pathHeading, sample: current, variation: hashUnit(seed) } : null);
    }

    // A rejected field sample splits the river. Taper each real run into its
    // banks instead of leaving a full-width rectangular cap at that break.
    for (let start = 0; start < limit;) {
      if (!sections[start]) { start += 1; continue; }
      let end = start + 1;
      while (end < limit && sections[end]) end += 1;
      for (let row = start; row <= end; row += 1) {
        const edgeDistance = Math.min(row - start, end - row);
        if (edgeDistance >= 2) continue;
        yield;
        rows[row] = makeRow((row - limit * 0.5) * SURFACE_RIVER_SECTION_METERS,
          edgeDistance === 0 ? 0.32 : 0.76);
      }
      for (let index = start; index < end && rivers < MAX_SURFACE_RIVER_SEGMENTS; index += 1) {
        yield;
        const back = rows[index]; const front = rows[index + 1]; const section = sections[index];
        if (!back || !front || !section) continue;
        // Narrowing a terminal cross-section resamples its true banks. Check
        // those final corners too; the rendered/physical surface never cheats
        // by raising an upstream row or bridging an uphill piece of terrain.
        if (front.meanHeightMeters > back.meanHeightMeters + MAX_SURFACE_RIVER_UPHILL_METERS) continue;
        const across = new Vector3().crossVectors(section.direction, section.heading).normalize();
        const corners = Object.freeze([...back.corners, ...front.corners]) as unknown as ContactFlowDescriptor['cornersBodyFixedMeters'];
        let halfLengthMeters = 0; let halfWidthMeters = 0;
        for (const corner of corners) {
          const offset = new Vector3().copy(corner).normalize().sub(section.direction).multiplyScalar(field.radius);
          halfLengthMeters = Math.max(halfLengthMeters, Math.abs(offset.dot(section.heading)));
          halfWidthMeters = Math.max(halfWidthMeters, Math.abs(offset.dot(across)));
        }
        const flow: ContactFlowDescriptor = Object.freeze({
          id: `${id}:river:${rivers}`, kind: 'river', appearance: 'channel',
          centerDirection: plain(section.direction), headingBodyFixed: plain(section.heading),
          halfLengthMeters: halfLengthMeters + 0.000_001, halfWidthMeters: halfWidthMeters + 0.000_001,
          strength: section.sample.riverStrength ?? 0, variation: section.variation,
          cornersBodyFixedMeters: corners,
        });
        if (!isValidSurfaceFlowDescriptor(flow, field.radius)) continue;
        flows.push(flow);
        rivers += 1;
        if (section.sample.heightMeters > 2 && section.sample.heightMeters < 210) {
          appendCascade(section.direction, section.heading, across, Math.min(back.halfWidthMeters, front.halfWidthMeters),
            section.sample.riverStrength ?? 0, section.variation);
        }
      }
      start = end;
    }
  };

  const appendConnectedLava = function* (): Generator<void, void, void> {
    const heading = new Vector3().crossVectors(center, Math.abs(center.y) > 0.9 ? new Vector3(0, 0, 1) : UP);
    heading.addScaledVector(center, -heading.dot(center));
    if (heading.lengthSq() < 0.00001) return;
    heading.normalize();
    const limit = MAX_SURFACE_LAVA_SEGMENTS;
    const spacing = 165;
    const sideways = new Vector3().crossVectors(center, heading).normalize();
    const broadAmplitude = 88;
    const fineAmplitude = 26;
    const broadScale = 510;
    const fineScale = 185;
    const broadPhase = hashUnit(field.seed ^ 0x24a7_5e31) * Math.PI * 2;
    const finePhase = hashUnit(field.seed ^ 0x83e1_54ad) * Math.PI * 2;
    const lateralAt = (distance: number): number => broadAmplitude * (Math.sin(distance / broadScale + broadPhase) - Math.sin(broadPhase))
      + fineAmplitude * (Math.sin(distance / fineScale + finePhase) - Math.sin(finePhase));
    const directionAt = (distance: number): Vector3 => center.clone().addScaledVector(heading, distance / field.radius)
      .addScaledVector(sideways, lateralAt(distance) / field.radius).normalize();
    for (let index = 0; index < limit; index += 1) {
      // A single channel tests a bounded number of authoritative samples.
      // Cooperative CPU fallback can yield between channels without changing
      // their deterministic order or physical footprint.
      yield;
      const distance = (index - (limit - 1) * 0.5) * spacing;
      const direction = directionAt(distance);
      const next = sample(direction);
      const strength = next.lavaStrength ?? 0;
      if (next.ocean || next.heightMeters <= 0 || strength <= 0.32) continue;
      const pathHeading = directionAt(distance + 48).sub(directionAt(distance - 48)).normalize();
      pathHeading.addScaledVector(direction, -pathHeading.dot(direction)).normalize();
      if (pathHeading.dot(heading) <= 0.72) continue;
      const seed = hashCoordinates(Math.round(direction.x * 65_536), Math.round(direction.y * 65_536),
        Math.round(direction.z * 65_536), field.seed ^ 0x04b1_9f37);
      const widthScale = clamp(0.95 + Math.sin(distance / 410 + broadPhase) * 0.1
        + Math.sin(distance / 185 + finePhase) * 0.055, 0.8, 1.12);
      appendLava(direction, next, hashUnit(seed), pathHeading, widthScale);
    }
  };

  if (field.landable && options.patchSizeMeters > 0 &&
    (field.archetype === 'ocean' || field.archetype === 'temperate' || field.archetype === 'volcanic')) {
    const waterBearing = field.archetype === 'ocean' || field.archetype === 'temperate';
    const volcanic = field.archetype === 'volcanic';
    const centerSample = sample(center);
    if (!centerSample.ocean && centerSample.heightMeters > 0) {
      if (waterBearing && (centerSample.riverStrength ?? 0) > 0.3) {
        yield* appendRiverRun(center, centerSample, MAX_SURFACE_RIVER_SEGMENTS, field.seed);
      }
      else if (volcanic && (centerSample.lavaStrength ?? 0) > 0.32) yield* appendConnectedLava();
    }
    const attempts = maximumInstances > 0 ? Math.max(240, Math.min(520, maximumInstances * 4)) : 0;
    const maximumMeters = Math.min(68_000, options.patchSizeMeters * 0.44);
    const nearMaximum = Math.min(maximumMeters, 31_000);
    const minimumMeters = Math.min(maximumMeters * 0.24, 48);
    const reference = Math.abs(center.y) > 0.9 ? new Vector3(0, 0, 1) : UP;
    const tangent = new Vector3().crossVectors(reference, center).normalize();
    const bitangent = new Vector3().crossVectors(center, tangent).normalize();
    for (let index = 0; index < attempts; index += 1) {
      yield;
      if ((waterBearing && rivers >= MAX_SURFACE_RIVER_SEGMENTS) ||
        (volcanic && lava >= MAX_SURFACE_LAVA_SEGMENTS)) continue;
      const phase = index * GOLDEN_ANGLE + hashUnit(field.seed ^ 0x42cf_761d) * Math.PI * 2;
      const progress = index / Math.max(1, attempts - 1);
      const radialVariation = hashUnit(hashCoordinates(index, 53, 97, field.seed ^ 0x54bd_7163));
      const distance = index >= 24 && index % 8 === 7 ? maximumMeters * (0.52 + radialVariation * 0.44)
        : index >= 24 && index % 8 === 6 ? maximumMeters * (0.19 + radialVariation * 0.34)
          : minimumMeters + Math.pow(progress, 1.63) * Math.max(0, nearMaximum - minimumMeters);
      const direction = center.clone().addScaledVector(tangent, Math.cos(phase) * distance / field.radius)
        .addScaledVector(bitangent, Math.sin(phase) * distance / field.radius).normalize();
      const current = sample(direction);
      if (current.ocean || current.heightMeters <= 0) continue;
      const anchorSeed = hashCoordinates(Math.round(direction.x * 65_536), Math.round(direction.y * 65_536), Math.round(direction.z * 65_536), field.seed);
      const variation = hashUnit(anchorSeed ^ 0x91e1_0da5);
      if (waterBearing && (current.riverStrength ?? 0) > 0.3 && !flows.some((flow) =>
        flow.kind === 'river' && surfaceFlowContains(field.radius, flow, direction, SURFACE_RIVER_SECTION_METERS))) {
        yield* appendRiverRun(direction, current, Math.min(7, MAX_SURFACE_RIVER_SEGMENTS - rivers), anchorSeed);
      }
      if (volcanic && (current.lavaStrength ?? 0) > 0.32) appendLava(direction, current, variation);
    }
  }
  return Object.freeze({ id, flowVersion: SURFACE_FLOW_GENERATOR_VERSION,
    fieldSeed: field.seed, fieldVersion: field.generatorVersion,
    bodyRadiusMeters: field.radius, centerDirection: plain(center), patchSizeMeters: options.patchSizeMeters,
    maximumInstances, flows: Object.freeze(flows) });
}

/** Synchronous fixtures and collision callers drain the identical stepped producer. */
export function buildSurfaceFlowRegion(field: PlanetField, options: SurfaceFlowRegionOptions): SurfaceFlowRegion {
  const task = createSurfaceFlowRegionTask(field, options);
  for (;;) {
    const step = task.next();
    if (step.done) return step.value;
  }
}
