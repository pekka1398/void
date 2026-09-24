import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  Vector3,
} from 'three';
import { attribute, instanceIndex, materialOpacity, mix, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

import {
  hashCoordinates,
  hashUnit,
  samplePlanetField,
  type PlanetField,
  type PlanetSurfaceSample,
} from '../../fields';
import { buildSurfaceFlowRegion, isValidSurfaceFlowRegion, type SurfaceFlowRegion } from '../../terrain/SurfaceFlowField';
import {
  createSurfaceFlowPalette,
  surfaceFlowCornerAcross,
  surfaceFlowTriangleColors,
  SURFACE_FLOW_APPEARANCE_POLICY,
  SURFACE_FLOW_TRIANGLE_CORNERS,
} from '../../terrain/SurfaceFlowAppearance';
import {
  getSurfaceSceneryBatch,
  surfaceSceneryOccupiesFlow,
  SURFACE_SCENERY_FEATURE_KINDS,
  type SurfaceSceneryBatchKind,
  type SurfaceSceneryBuffers,
  type SurfaceSceneryFeatureKind,
} from '../../terrain/SurfaceScenery';

export interface PlanetarySurfaceFeaturesOptions {
  renderRadius: number;
  centerDirection: Vector3;
  patchCenter: Vector3;
  patchSize: number;
  segments?: number;
  maxInstances?: number;
  /** A contact lease can pin the existing immutable liquid region through recentering. */
  flowRegion?: SurfaceFlowRegion;
  /** Product path: all field sampling and instance transforms came from a worker. */
  preparedScenery?: SurfaceSceneryBuffers;
}

export interface PlanetarySurfaceFeatureStats {
  riverSegments: number;
  lavaSegments: number;
  ventInstances: number;
  craterInstances: number;
  floraInstances: number;
  rockInstances: number;
  drawCalls: number;
}

/** Optional channels keep this renderer compatible with older field versions. */
type EcologySample = PlanetSurfaceSample & {
  readonly biomeId?: string;
  readonly riverStrength?: number;
  readonly riverDepthMeters?: number;
  readonly riverDirection?: { readonly x: number; readonly y: number; readonly z: number };
  readonly drainage?: number;
  readonly lavaStrength?: number;
  readonly volcanoStrength?: number;
  readonly craterStrength?: number;
  readonly mineralRichness?: number;
  readonly vegetationDensity?: number;
};

type FeatureKind = 'flora' | 'ice-crystal' | 'desert-mineral' | 'mineral' | 'volcanic-rock' | 'vent' | 'crater';

interface SurfaceAnchor {
  direction: Vector3;
  sample: EcologySample;
  variation: number;
  distanceMeters: number;
  kind: FeatureKind;
}

interface RibbonBuffer {
  positions: number[];
  colors: number[];
  across: number[];
  anchors: Array<{ x: number; y: number; z: number }>;
  cascadeEndpoints: Array<{
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
  }>;
}

interface ActualFlowSegment {
  direction: Vector3;
  heading: Vector3;
  halfLengthMeters: number;
  halfWidthMeters: number;
  kind: 'river' | 'lava';
}

const UP = new Vector3(0, 1, 0);
const GOLDEN_ANGLE = 2.399_963_229_728_653;
const MAX_DRAWS = 6;

/** Install a bounded worker-produced instance slice without resampling or matrix loops. */
export function applyPreparedSurfaceInstances(
  mesh: InstancedMesh,
  prepared: SurfaceSceneryBuffers,
  kind: SurfaceSceneryBatchKind,
  includeColors = true,
): void {
  const batch = getSurfaceSceneryBatch(prepared, kind);
  const end = batch.offset + batch.count;
  mesh.instanceMatrix = new InstancedBufferAttribute(
    prepared.instanceMatrices.subarray(batch.offset * 16, end * 16), 16,
  );
  if (includeColors) mesh.instanceColor = new InstancedBufferAttribute(
    prepared.instanceColors.subarray(batch.offset * 3, end * 3), 3,
  );
  mesh.count = batch.count;
  const anchors: Array<{ x: number; y: number; z: number }> = [];
  const featureKinds: SurfaceSceneryFeatureKind[] = [];
  for (let index = batch.offset; index < end; index += 1) {
    const offset = index * 3;
    anchors.push({ x: prepared.instanceDirections[offset]!, y: prepared.instanceDirections[offset + 1]!,
      z: prepared.instanceDirections[offset + 2]! });
    featureKinds.push(SURFACE_SCENERY_FEATURE_KINDS[prepared.instanceKinds[index]!] ?? 'decoration');
  }
  mesh.userData.anchors = anchors;
  mesh.userData.featureKinds = featureKinds;
  mesh.userData.maximumPhysicalDistanceMeters = batch.maximumDistanceMeters;
  mesh.userData.preparedInstanceBatch = kind;
  mesh.frustumCulled = false;
}

/** One instanced draw bends only foliage tips; every real ground root stays fixed. */
export class LivingFloraNodeMaterial extends MeshBasicNodeMaterial {
  readonly windUniforms = {
    time: uniform(0),
    speedMetersPerSecond: uniform(0),
    direction: uniform(new Vector3(1, 0, 0)),
    seedPhase: uniform(0),
    daylight: uniform(1),
    nightGlow: uniform(0),
  };

  constructor(seed: number) {
    super({ color: '#FFFFFF', vertexColors: true, toneMapped: false });
    this.windUniforms.seedPhase.value = hashUnit(seed ^ 0x65d4_3af9) * Math.PI * 2;

    const rooted = smoothstep(0.085, 0.76, positionLocal.y.max(0));
    const wind = this.windUniforms.speedMetersPerSecond.clamp(0, 42).div(42);
    const phase = instanceIndex.toFloat().mul(0.713)
      .add(this.windUniforms.seedPhase)
      .add(positionLocal.y.mul(2.9));
    const flowing = this.windUniforms.time.mul(wind.mul(1.35).add(0.72)).add(phase).sin();
    const breathing = this.windUniforms.time.mul(0.63).sub(phase.mul(1.43)).cos();
    const sway = flowing.mul(0.075).add(breathing.mul(0.027))
      .mul(wind.mul(0.82).add(0.18)).mul(rooted);
    const crosswind = this.windUniforms.direction.z.negate();
    this.positionNode = positionLocal.add(vec3(
      this.windUniforms.direction.x.mul(sway).add(crosswind.mul(breathing).mul(rooted).mul(0.015)),
      rooted.mul(flowing.abs()).mul(wind).mul(0.012),
      this.windUniforms.direction.z.mul(sway)
        .add(this.windUniforms.direction.x.mul(breathing).mul(rooted).mul(0.015)),
    ));
    // Seeded biological light belongs to these existing real rooted plants;
    // it wakes only under the actual stellar frame and adds no geometry/draws.
    const crown = smoothstep(0.12, 0.78, positionLocal.y.max(0));
    const vein = phase.mul(2.7).add(positionLocal.y.mul(6.3))
      .add(this.windUniforms.time.mul(0.92)).sin().mul(0.5).add(0.5).pow(3);
    const hue = instanceIndex.toFloat().mul(0.71).add(this.windUniforms.seedPhase)
      .sin().mul(0.5).add(0.5);
    const bioluminescence = mix(vec3(0.09, 1.68, 1.42), vec3(1.47, 0.28, 1.16), hue)
      .mul(crown.mul(0.49).add(vein.mul(0.38)))
      .mul(this.windUniforms.nightGlow);
    this.colorNode = vec3(this.windUniforms.daylight.mul(0.25).add(0.75)).add(bioluminescence);
    this.userData.rootedWindAnimation = true;
    this.userData.bodyFixedVegetation = true;
    this.userData.rootLockHeight = 0.085;
    this.userData.shaderLanguage = 'three-shading-language';
    this.userData.nightReactiveBioluminescence = true;
  }

  setWind(speedMetersPerSecond: number, direction?: Vector3): void {
    this.windUniforms.speedMetersPerSecond.value = Number.isFinite(speedMetersPerSecond)
      ? clamp(speedMetersPerSecond, 0, 42)
      : 0;
    if (direction && direction.lengthSq() > 0) {
      this.windUniforms.direction.value.set(direction.x, 0, direction.z);
      if (this.windUniforms.direction.value.lengthSq() > 0) {
        this.windUniforms.direction.value.normalize();
      } else {
        this.windUniforms.direction.value.set(1, 0, 0);
      }
    }
  }

  /** Actual daylight alone controls emission; no seeded plant or root moves. */
  setCelestialIllumination(daylight: number): void {
    const value = Number.isFinite(daylight) ? clamp(daylight) : 1;
    this.windUniforms.daylight.value = value;
    this.windUniforms.nightGlow.value = (1 - value) ** 1.45;
  }
}

/** Authoritative sampled channel geometry gains motion without another draw. */
export class SurfaceFlowNodeMaterial extends MeshBasicNodeMaterial {
  readonly flowUniforms = {
    time: uniform(0),
    speedMetersPerSecond: uniform(0),
    metersPerRender: uniform(1),
    originAlongMeters: uniform(0),
    direction: uniform(new Vector3(1, 0, 0)),
    phase: uniform(0),
    daylight: uniform(1),
  };

  constructor(kind: 'river' | 'lava', field: PlanetField, renderRadius: number, direction: Vector3) {
    super({
      color: '#FFFFFF',
      vertexColors: false,
      transparent: kind === 'river',
      opacity: kind === 'river' ? 0.93 : 1,
      side: DoubleSide,
      depthWrite: kind !== 'river',
      toneMapped: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.flowUniforms.metersPerRender.value = field.radius / Math.max(renderRadius, Number.EPSILON);
    this.flowUniforms.direction.value.copy(direction).normalize();
    this.flowUniforms.phase.value = hashUnit(field.seed ^ (kind === 'river' ? 0x67a4_109d : 0x43d2_71bc)) * Math.PI * 2;

    const sampledColor = attribute<'vec3'>('color', 'vec3');
    const bodyMeters = positionLocal.dot(this.flowUniforms.direction).mul(this.flowUniforms.metersPerRender)
      .add(this.flowUniforms.originAlongMeters);
    const velocity = this.flowUniforms.speedMetersPerSecond.clamp(0, 42).mul(kind === 'river' ? 0.24 : 0.045)
      .add(kind === 'river' ? 3.8 : 0.82);
    const current = bodyMeters.mul(kind === 'river' ? 0.036 : 0.022)
      .sub(this.flowUniforms.time.mul(velocity))
      .add(this.flowUniforms.phase);
    const turbulence = current.sin().mul(0.5).add(0.5);
    const crossing = bodyMeters.mul(kind === 'river' ? 0.073 : 0.057)
      .add(this.flowUniforms.phase.mul(0.67))
      .add(this.flowUniforms.time.mul(kind === 'river' ? 1.13 : 0.37)).sin().mul(0.5).add(0.5);
    const crest = turbulence.mul(crossing).pow(kind === 'river' ? 2.4 : 3.8);
    const bank = kind === 'river'
      ? smoothstep(0.56, 1, attribute<'float'>('flowAcross', 'float').abs()) : null;
    const illuminatedFlow = kind === 'river'
      ? sampledColor.mul(turbulence.mul(0.1).add(0.83)).mul(bank!.mul(0.2).add(0.8))
        .add(vec3(0.055, 0.32, 0.34).mul(crest).mul(bank!.mul(-0.55).add(1)).mul(0.075))
        .add(vec3(0.1, 0.26, 0.25).mul(crossing.pow(5)).mul(bank!).mul(0.035))
      : sampledColor.mul(turbulence.mul(0.25).add(0.69))
        .add(vec3(1, 0.29, 0.045).mul(crest).mul(0.47));
    // Water reflects the actual local stellar illumination; only geothermal
    // lava remains self-luminous when both real suns are below the horizon.
    this.colorNode = kind === 'river'
      ? illuminatedFlow.mul(this.flowUniforms.daylight.mul(0.92).add(0.08))
      : illuminatedFlow;
    // SurfacePatch owns the layer fade through material.opacity. Keep the
    // bank profile normalized so it cannot bypass that real residency fade.
    if (kind === 'river') this.opacityNode = materialOpacity.mul(mix(1, 0.7 / 0.93, bank!));
    this.userData.flowKind = kind;
    this.userData.bodyFixedFlow = true;
    this.userData.crossingCurrentBands = true;
    this.userData.flowAppearancePolicy = SURFACE_FLOW_APPEARANCE_POLICY;
    this.userData.sharedBankCoordinates = kind === 'river';
    this.userData.presentationOpacity = kind === 'river';
    this.userData.shaderLanguage = 'three-shading-language';
  }
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function plainDirection(direction: Vector3): { x: number; y: number; z: number } {
  return { x: direction.x, y: direction.y, z: direction.z };
}

function sampled(field: PlanetField, direction: Vector3): EcologySample {
  return samplePlanetField(field, direction) as EcologySample;
}

function pushTriangle(
  positions: number[],
  colors: number[],
  first: Vector3,
  second: Vector3,
  third: Vector3,
  tone: Color,
): void {
  for (const point of [first, second, third]) {
    positions.push(point.x, point.y, point.z);
    colors.push(tone.r, tone.g, tone.b);
  }
}

function geometryFrom(positions: number[], colors: number[], flowAcross?: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  if (flowAcross) geometry.setAttribute('flowAcross', new BufferAttribute(new Float32Array(flowAcross), 1));
  geometry.computeVertexNormals();
  return geometry;
}

/** Distinct folded petals and a tilted crown avoid conical toy-tree silhouettes. */
function createAlienFloraGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const root = new Vector3(0, 0.035, 0);

  for (let blade = 0; blade < 9; blade += 1) {
    const angle = blade * GOLDEN_ANGLE;
    const outward = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const side = new Vector3(-outward.z, 0, outward.x);
    const height = 0.26 + (blade % 4) * 0.095;
    const tip = outward.clone().multiplyScalar(0.47 + (blade % 3) * 0.2).setY(height);
    const knee = outward.clone().multiplyScalar(0.21 + (blade % 2) * 0.12).setY(height * 0.48);
    const left = knee.clone().addScaledVector(side, 0.18 + (blade % 3) * 0.04);
    const right = knee.clone().addScaledVector(side, -0.16 - (blade % 2) * 0.032);
    const lit = new Color().setRGB(0.56, 0.39 + (blade % 3) * 0.065, 0.7);
    const shade = new Color().setRGB(0.31, 0.25 + (blade % 2) * 0.075, 0.53);
    const crown = tip.clone().multiplyScalar(0.83).addScaledVector(side, blade % 2 === 0 ? 0.12 : -0.11);
    crown.y = height * 0.82;
    pushTriangle(positions, colors, root, left, tip, lit);
    pushTriangle(positions, colors, root, tip, right, shade);
    pushTriangle(positions, colors, left, right, tip, new Color(0.46, 0.56, 0.68));
    pushTriangle(positions, colors, left, crown, tip, new Color(0.51, 0.37, 0.64));
  }

  const geometry = geometryFrom(positions, colors);
  geometry.userData.silhouette = 'faceted-alien-folded-crown';
  geometry.userData.sculpturalCanopy = true;
  geometry.userData.rootLock = true;
  return geometry;
}

/** One instanced draw carries frozen ice, desert minerals, and local rock clusters. */
function createMineralClusterGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  for (const [centerX, centerZ, radius, height, tilt] of [
    [-0.33, 0.12, 0.24, 0.62, -0.16],
    [0.08, -0.07, 0.3, 0.91, 0.15],
    [0.39, 0.14, 0.2, 0.48, 0.12],
    [-0.08, -0.3, 0.17, 0.37, -0.1],
  ] as const) {
    const tip = new Vector3(centerX + tilt, height, centerZ + tilt * 0.32);
    const ring = Array.from({ length: 5 }, (_, face) => {
      const angle = face * Math.PI * 2 / 5;
      return new Vector3(centerX + Math.cos(angle) * radius, 0.02, centerZ + Math.sin(angle) * radius);
    });

    for (let face = 0; face < ring.length; face += 1) {
      const shade = 0.57 + face % 3 * 0.14;
      pushTriangle(
        positions,
        colors,
        ring[face]!,
        ring[(face + 1) % ring.length]!,
        tip,
        new Color(shade * 0.9, shade * 0.96, Math.min(1, shade * 1.1)),
      );
    }
  }

  const geometry = geometryFrom(positions, colors);
  geometry.userData.silhouette = 'faceted-asymmetric-geological-shards';
  geometry.userData.sculpturalClusterCount = 4;
  return geometry;
}

function createVentGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const dark = new Color('#432334');
  const ember = new Color('#FF674B');
  const center = new Vector3(0, 0.07, 0);

  for (let face = 0; face < 7; face += 1) {
    const angle = face * Math.PI * 2 / 7;
    const nextAngle = (face + 1) * Math.PI * 2 / 7;
    const outer = new Vector3(Math.cos(angle) * 0.62, 0.02, Math.sin(angle) * 0.62);
    const nextOuter = new Vector3(Math.cos(nextAngle) * 0.62, 0.02, Math.sin(nextAngle) * 0.62);
    const inner = new Vector3(Math.cos(angle) * 0.24, 0.24 + face % 2 * 0.06, Math.sin(angle) * 0.24);
    const nextInner = new Vector3(Math.cos(nextAngle) * 0.24, 0.24 + (face + 1) % 2 * 0.06, Math.sin(nextAngle) * 0.24);
    pushTriangle(positions, colors, outer, nextOuter, inner, dark);
    pushTriangle(positions, colors, nextOuter, nextInner, inner, new Color('#754052'));
    pushTriangle(positions, colors, center, inner, nextInner, ember);
  }

  const geometry = geometryFrom(positions, colors);
  geometry.userData.silhouette = 'faceted-emissive-volcanic-vent';
  return geometry;
}

/**
 * Bounded body-fixed ecology. Every placement is accepted by the exact same
 * radial field that owns collision, terrain triangles, and genuine ocean masks.
 */
export class PlanetarySurfaceFeatures extends Group {
  readonly flowRegion: SurfaceFlowRegion;
  readonly stats: PlanetarySurfaceFeatureStats = {
    riverSegments: 0,
    lavaSegments: 0,
    ventInstances: 0,
    craterInstances: 0,
    floraInstances: 0,
    rockInstances: 0,
    drawCalls: 0,
  };

  private readonly field: PlanetField;
  private readonly options: PlanetarySurfaceFeaturesOptions;
  private readonly centerDirection: Vector3;
  private readonly patchCenter: Vector3;
  private readonly meterScale: number;
  private readonly river: RibbonBuffer = { positions: [], colors: [], across: [], anchors: [], cascadeEndpoints: [] };
  private readonly lava: RibbonBuffer = { positions: [], colors: [], across: [], anchors: [], cascadeEndpoints: [] };
  private readonly flowSegments: ActualFlowSegment[] = [];
  private riverMaterial?: SurfaceFlowNodeMaterial;
  private lavaMaterial?: SurfaceFlowNodeMaterial;
  private ventMaterial?: MeshLambertMaterial;
  private floraMaterial?: LivingFloraNodeMaterial;
  private readonly windDirection = new Vector3(1, 0, 0);
  private windSpeedMetersPerSecond = 0;
  private celestialDaylight = 1;

  constructor(field: PlanetField, options: PlanetarySurfaceFeaturesOptions) {
    super();
    this.field = field;
    this.options = options;
    this.centerDirection = options.centerDirection.clone().normalize();
    this.patchCenter = options.patchCenter.clone();
    this.meterScale = Math.max(Number.EPSILON, options.renderRadius / field.radius);
    if (options.preparedScenery && !options.preparedScenery.flowRegion) {
      throw new Error('Prepared ecology must include its actual immutable liquid region.');
    }
    this.flowRegion = options.preparedScenery?.flowRegion ?? options.flowRegion ?? buildSurfaceFlowRegion(field, {
      centerDirection: this.centerDirection,
      patchSizeMeters: options.patchSize / this.meterScale,
      maxInstances: options.maxInstances,
    });
    if (!isValidSurfaceFlowRegion(this.flowRegion, field)) {
      throw new Error('A surface liquid region must belong to the same actual planet field.');
    }
    this.name = 'planetary-surface-features';
    this.frustumCulled = false;
    this.userData.planetField = field;
    this.userData.centerDirection = plainDirection(this.centerDirection);
    this.userData.stats = this.stats;
    this.userData.flowSegments = this.flowSegments;
    this.userData.flowRegionId = this.flowRegion.id;

    if (field.landable && options.patchSize > 0 && options.renderRadius > 0) {
      if (options.preparedScenery) this.buildPrepared(options.preparedScenery);
      else this.build();
    }
  }

  private buildPrepared(prepared: SurfaceSceneryBuffers): void {
    if (prepared.fieldSeed !== this.field.seed || prepared.fieldVersion !== this.field.generatorVersion ||
      prepared.bodyRadiusMeters !== this.field.radius || prepared.renderRadius !== this.options.renderRadius ||
      prepared.patchSize !== this.options.patchSize || this.patchCenter.distanceToSquared(new Vector3().copy(prepared.origin)) > 1e-20 ||
      this.centerDirection.distanceToSquared(new Vector3().copy(prepared.centerDirection)) > 1e-20) {
      throw new Error('Prepared ecology belongs to a different physical surface generation.');
    }
    const volcanic = this.field.archetype === 'volcanic';
    const frozen = this.field.archetype === 'frozen' || this.field.archetype === 'ice-moon';
    const desert = this.field.archetype === 'desert';
    this.userData.physicalCoverageRadiusMeters = prepared.ecologyCoverageRadiusMeters;
    this.userData.nearCoverageRadiusMeters = prepared.nearEcologyCoverageRadiusMeters;
    this.userData.farPlacementStride = 8;
    this.appendRegionFlows();
    if (getSurfaceSceneryBatch(prepared, 'ecologyFlora').count > 0) this.addFlora([], prepared);
    if (getSurfaceSceneryBatch(prepared, 'ecologyRocks').count > 0) this.addRocks([], frozen, desert, volcanic, prepared);
    if (this.river.positions.length > 0) this.addRiver();
    if (this.lava.positions.length > 0) this.addLava();
    if (getSurfaceSceneryBatch(prepared, 'ecologyVents').count > 0) this.addVents([], prepared);
    this.stats.drawCalls = this.children.length;
    this.userData.instanceBudget = prepared.ecologyMaximumInstances;
    this.userData.maximumDrawCalls = MAX_DRAWS;
    this.userData.cascadeSegments = this.river.cascadeEndpoints.length;
    this.userData.workerPrepared = true;
  }

  private directionAt(tangent: Vector3, bitangent: Vector3, xMeters: number, zMeters: number): Vector3 {
    return this.centerDirection.clone()
      .addScaledVector(tangent, xMeters / this.field.radius)
      .addScaledVector(bitangent, zMeters / this.field.radius)
      .normalize();
  }

  private localPosition(direction: Vector3, sample: EcologySample, offsetMeters = 0): Vector3 {
    return direction.clone()
      .multiplyScalar(this.options.renderRadius + (sample.heightMeters + offsetMeters) * this.meterScale)
      .sub(this.patchCenter);
  }

  private build(): void {
    const waterBearing = this.field.archetype === 'ocean' || this.field.archetype === 'temperate';
    const volcanic = this.field.archetype === 'volcanic';
    const frozen = this.field.archetype === 'frozen' || this.field.archetype === 'ice-moon';
    const desert = this.field.archetype === 'desert';
    const maxInstances = Math.max(0, Math.min(160, Math.round(this.options.maxInstances ?? 112)));
    const floraBudget = waterBearing ? Math.max(0, Math.round(maxInstances * 0.53)) : 0;
    const rockBudget = Math.max(0, Math.round(maxInstances * (frozen || desert ? 0.72 : 0.4)));
    const ventBudget = volcanic ? Math.max(0, Math.round(maxInstances * 0.25)) : 0;
    const attempts = maxInstances > 0 ? Math.max(240, Math.min(520, maxInstances * 4)) : 0;
    const availableMeters = this.options.patchSize / this.meterScale;
    const maximumMeters = Math.min(68_000, availableMeters * 0.44);
    const nearMaximumMeters = Math.min(maximumMeters, 31_000);
    const minimumMeters = Math.min(maximumMeters * 0.24, 48);
    this.userData.physicalCoverageRadiusMeters = maximumMeters;
    this.userData.nearCoverageRadiusMeters = nearMaximumMeters;
    this.userData.farPlacementStride = 8;
    const reference = Math.abs(this.centerDirection.y) > 0.9 ? new Vector3(0, 0, 1) : UP;
    const tangent = new Vector3().crossVectors(reference, this.centerDirection).normalize();
    const bitangent = new Vector3().crossVectors(this.centerDirection, tangent).normalize();
    const flora: SurfaceAnchor[] = [];
    const rocks: SurfaceAnchor[] = [];
    const vents: SurfaceAnchor[] = [];
    this.appendRegionFlows();

    for (let index = 0; index < attempts; index += 1) {
      const phase = index * GOLDEN_ANGLE + hashUnit(this.field.seed ^ 0x42cf_761d) * Math.PI * 2;
      const progress = index / Math.max(1, attempts - 1);
      const radialVariation = hashUnit(hashCoordinates(index, 53, 97, this.field.seed ^ 0x54bd_7163));
      const distanceMeters = index >= 24 && index % 8 === 7
        ? maximumMeters * (0.52 + radialVariation * 0.44)
        : index >= 24 && index % 8 === 6
          ? maximumMeters * (0.19 + radialVariation * 0.34)
          : minimumMeters + Math.pow(progress, 1.63) * Math.max(0, nearMaximumMeters - minimumMeters);
      const direction = this.directionAt(
        tangent,
        bitangent,
        Math.cos(phase) * distanceMeters,
        Math.sin(phase) * distanceMeters,
      );
      const sample = sampled(this.field, direction);
      if (sample.ocean || sample.heightMeters <= 0) continue;

      const anchorSeed = hashCoordinates(
        Math.round(direction.x * 65_536),
        Math.round(direction.y * 65_536),
        Math.round(direction.z * 65_536),
        this.field.seed,
      );
      const variation = hashUnit(anchorSeed ^ 0x91e1_0da5);
      const lavaStrength = sample.lavaStrength ?? 0;

      // Drainage strength describes the broad real valley, not submerged
      // terrain. Only the generated liquid footprint excludes dry-bank life.
      if (this.occupiesFlow(direction)) continue;

      if (
        volcanic &&
        vents.length < ventBudget &&
        lavaStrength > 0 &&
        (sample.volcanoStrength ?? 0) > 0.27 &&
        distanceMeters >= 310 &&
        distanceMeters <= 4_400 &&
        variation < 0.62
      ) {
        const crater = (sample.craterStrength ?? 0) > 0.34;
        vents.push({
          direction,
          sample,
          variation,
          distanceMeters,
          kind: crater ? 'crater' : 'vent',
        });
        continue;
      }

      if (
        waterBearing &&
        flora.length < floraBudget &&
        (sample.vegetationDensity ?? 0) > 0.2 &&
        sample.moisture > 0.18 &&
        variation < 0.75
      ) {
        flora.push({ direction, sample, variation, distanceMeters, kind: 'flora' });
      } else if (
        rocks.length < rockBudget &&
        (sample.mineralRichness ?? 0) > (frozen || desert ? 0.3 : 0.38)
      ) {
        const kind: FeatureKind = frozen
          ? 'ice-crystal'
          : desert
            ? 'desert-mineral'
            : volcanic
              ? 'volcanic-rock'
              : 'mineral';
        rocks.push({ direction, sample, variation, distanceMeters, kind });
      }
    }

    if (flora.length > 0) this.addFlora(flora);
    if (rocks.length > 0) this.addRocks(rocks, frozen, desert, volcanic);
    if (this.river.positions.length > 0) this.addRiver();
    if (this.lava.positions.length > 0) this.addLava();
    if (vents.length > 0) this.addVents(vents);

    this.stats.drawCalls = this.children.length;
    this.userData.instanceBudget = maxInstances;
    this.userData.maximumDrawCalls = MAX_DRAWS;
    this.userData.cascadeSegments = this.river.cascadeEndpoints.length;
  }

  /** Render the immutable shared liquid region without regenerating its footprint. */
  private appendRegionFlows(): void {
    const palette = createSurfaceFlowPalette(this.field);
    for (const flow of this.flowRegion.flows) {
      const isRiver = flow.kind === 'river';
      const cascade = flow.appearance === 'cascade';
      const local = flow.cornersBodyFixedMeters.map((point) => new Vector3(point.x, point.y, point.z)
        .multiplyScalar(this.meterScale).sub(this.patchCenter));
      const buffer = isRiver ? this.river : this.lava;
      const colors = surfaceFlowTriangleColors(palette, flow);
      for (let vertex = 0; vertex < SURFACE_FLOW_TRIANGLE_CORNERS.length; vertex += 1) {
        const corner = SURFACE_FLOW_TRIANGLE_CORNERS[vertex]!;
        const point = local[corner]!; const color = colors[vertex]!;
        buffer.positions.push(point.x, point.y, point.z);
        buffer.colors.push(color[0], color[1], color[2]);
        buffer.across.push(surfaceFlowCornerAcross(corner));
      }
      if (cascade) {
        const start = new Vector3().addVectors(
          new Vector3(flow.cornersBodyFixedMeters[0].x, flow.cornersBodyFixedMeters[0].y, flow.cornersBodyFixedMeters[0].z),
          new Vector3(flow.cornersBodyFixedMeters[1].x, flow.cornersBodyFixedMeters[1].y, flow.cornersBodyFixedMeters[1].z),
        ).normalize();
        const end = new Vector3().addVectors(
          new Vector3(flow.cornersBodyFixedMeters[2].x, flow.cornersBodyFixedMeters[2].y, flow.cornersBodyFixedMeters[2].z),
          new Vector3(flow.cornersBodyFixedMeters[3].x, flow.cornersBodyFixedMeters[3].y, flow.cornersBodyFixedMeters[3].z),
        ).normalize();
        buffer.cascadeEndpoints.push({ start: plainDirection(start), end: plainDirection(end) });
        continue;
      }
      buffer.anchors.push({ ...flow.centerDirection });
      this.flowSegments.push({
        direction: new Vector3(flow.centerDirection.x, flow.centerDirection.y, flow.centerDirection.z),
        heading: new Vector3(flow.headingBodyFixed.x, flow.headingBodyFixed.y, flow.headingBodyFixed.z),
        halfLengthMeters: flow.halfLengthMeters,
        halfWidthMeters: flow.halfWidthMeters,
        kind: flow.kind,
      });
      if (isRiver) this.stats.riverSegments += 1;
      else this.stats.lavaSegments += 1;
    }
  }

  /** Query real generated liquid, never the much broader drainage potential. */
  occupiesFlow(
    directionInput: { x: number; y: number; z: number },
    safetyMeters = 8,
  ): boolean {
    return surfaceSceneryOccupiesFlow(this.flowRegion, directionInput, safetyMeters);
  }

  private addFlora(anchors: SurfaceAnchor[], prepared?: SurfaceSceneryBuffers): void {
    this.floraMaterial = new LivingFloraNodeMaterial(this.field.seed ^ 0x2fa6_815d);
    this.floraMaterial.setWind(this.windSpeedMetersPerSecond, this.windDirection);
    this.floraMaterial.setCelestialIllumination(this.celestialDaylight);
    const count = prepared ? getSurfaceSceneryBatch(prepared, 'ecologyFlora').count : anchors.length;
    const mesh = new InstancedMesh(createAlienFloraGeometry(), this.floraMaterial, count);
    const palette = this.field.archetype === 'temperate'
      ? ['#479980', '#73A67C', '#9873AE', '#6189A3']
      : ['#9F598F', '#7F61A5', '#489489', '#A96B93'];
    if (prepared) applyPreparedSurfaceInstances(mesh, prepared, 'ecologyFlora');
    else this.populateInstances(mesh, anchors, palette, 10, 31, 0.94);
    mesh.name = 'surface-flora';
    if (!prepared) mesh.userData.featureKinds = anchors.map((anchor) => anchor.kind);
    mesh.userData.instanceBudget = this.options.maxInstances ?? 112;
    mesh.userData.rootedWindAnimation = true;
    mesh.userData.sculpturalCanopy = true;
    this.stats.floraInstances = count;
    this.add(mesh);
  }

  private addRocks(anchors: SurfaceAnchor[], frozen: boolean, desert: boolean, volcanic: boolean, prepared?: SurfaceSceneryBuffers): void {
    const material = new MeshLambertMaterial({
      color: '#FFFFFF',
      vertexColors: true,
      flatShading: true,
      emissive: frozen ? '#325A78' : volcanic ? '#482030' : '#312744',
      emissiveIntensity: frozen ? 0.63 : 0.43,
    });
    const count = prepared ? getSurfaceSceneryBatch(prepared, 'ecologyRocks').count : anchors.length;
    const mesh = new InstancedMesh(createMineralClusterGeometry(), material, count);
    const palette = frozen
      ? ['#9ADBE7', '#74B8D4', '#AEC8E4', '#91D5DF']
      : desert
        ? ['#D4AB78', '#BA8B62', '#CA996B', '#9F7077']
        : volcanic
          ? ['#783B51', '#A45852', '#5B3348', '#AA715B']
          : ['#64BAAE', '#987AC9', '#55A8A8', '#BB95CE'];
    if (prepared) applyPreparedSurfaceInstances(mesh, prepared, 'ecologyRocks');
    else this.populateInstances(mesh, anchors, palette, frozen ? 15 : 9, frozen ? 62 : 37, frozen ? 0.46 : 0.66);
    mesh.name = 'surface-rocks';
    if (!prepared) mesh.userData.featureKinds = anchors.map((anchor) => anchor.kind);
    const featureKinds = mesh.userData.featureKinds as SurfaceSceneryFeatureKind[];
    mesh.userData.iceInstances = featureKinds.filter((kind) => kind === 'ice-crystal').length;
    mesh.userData.mineralInstances = featureKinds.filter((kind) => kind === 'desert-mineral' || kind === 'mineral').length;
    mesh.userData.instanceBudget = this.options.maxInstances ?? 112;
    this.stats.rockInstances = count;
    this.add(mesh);
  }

  private addVents(anchors: SurfaceAnchor[], prepared?: SurfaceSceneryBuffers): void {
    this.ventMaterial = new MeshLambertMaterial({
      color: '#FFFFFF',
      vertexColors: true,
      flatShading: true,
      emissive: '#FF573B',
      emissiveIntensity: 1.08,
      fog: false,
      toneMapped: false,
    });
    const count = prepared ? getSurfaceSceneryBatch(prepared, 'ecologyVents').count : anchors.length;
    const mesh = new InstancedMesh(createVentGeometry(), this.ventMaterial, count);
    if (prepared) applyPreparedSurfaceInstances(mesh, prepared, 'ecologyVents');
    else this.populateInstances(mesh, anchors, ['#FFCC72', '#FF8550', '#E85741'], 23, 62, 1.42);
    mesh.name = 'surface-vents';
    if (!prepared) mesh.userData.featureKinds = anchors.map((anchor) => anchor.kind);
    mesh.userData.instanceBudget = this.options.maxInstances ?? 112;
    this.stats.ventInstances = count;
    this.stats.craterInstances = (mesh.userData.featureKinds as SurfaceSceneryFeatureKind[]).filter((kind) => kind === 'crater').length;
    this.add(mesh);
  }

  private populateInstances(
    mesh: InstancedMesh,
    anchors: SurfaceAnchor[],
    palette: string[],
    minimumHeightMeters: number,
    maximumHeightMeters: number,
    widthRatio: number,
  ): void {
    const transform = new Object3D();

    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index]!;
      const visibleHeight = minimumHeightMeters + anchor.variation * (maximumHeightMeters - minimumHeightMeters);
      const height = Math.min(visibleHeight * this.meterScale, Math.max(anchor.distanceMeters, 36) * this.meterScale * 0.17);
      const width = height * widthRatio * (0.78 + anchor.variation * 0.38);
      transform.position.copy(this.localPosition(anchor.direction, anchor.sample));
      transform.quaternion.setFromUnitVectors(UP, anchor.direction);
      transform.rotateY(anchor.variation * Math.PI * 2);
      transform.scale.set(width, height, width * (0.78 + anchor.variation * 0.32));
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      mesh.setColorAt(index, new Color(palette[index % palette.length]!));
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.anchors = anchors.map((anchor) => plainDirection(anchor.direction));
    mesh.userData.instanceBudget = this.options.maxInstances ?? 112;
    mesh.userData.maximumPhysicalDistanceMeters = Math.max(
      ...anchors.map((anchor) => anchor.distanceMeters),
    );
    mesh.frustumCulled = false;
  }

  private addRiver(): void {
    const flowDirection = this.flowSegments.find((segment) => segment.kind === 'river')?.heading
      ?? this.windDirection;
    this.riverMaterial = new SurfaceFlowNodeMaterial('river', this.field, this.options.renderRadius, flowDirection);
    this.riverMaterial.flowUniforms.originAlongMeters.value = this.patchCenter.clone().multiplyScalar(1 / this.meterScale)
      .sub(new Vector3(this.flowRegion.centerDirection.x, this.flowRegion.centerDirection.y, this.flowRegion.centerDirection.z)
        .multiplyScalar(this.field.radius)).dot(flowDirection);
    this.riverMaterial.flowUniforms.speedMetersPerSecond.value = this.windSpeedMetersPerSecond;
    this.riverMaterial.flowUniforms.daylight.value = this.celestialDaylight;
    const mesh = new Mesh(geometryFrom(this.river.positions, this.river.colors, this.river.across), this.riverMaterial);
    mesh.name = 'surface-rivers';
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    mesh.userData.anchors = this.river.anchors;
    mesh.userData.flowSegments = this.flowSegments.filter((segment) => segment.kind === 'river');
    mesh.userData.cascadeEndpoints = this.river.cascadeEndpoints;
    mesh.userData.segmentCount = this.stats.riverSegments;
    mesh.userData.bodyFixedCurrent = true;
    mesh.userData.crossingCurrentBands = true;
    mesh.userData.flowAppearancePolicy = SURFACE_FLOW_APPEARANCE_POLICY;
    this.add(mesh);
  }

  private addLava(): void {
    const flowDirection = this.flowSegments.find((segment) => segment.kind === 'lava')?.heading
      ?? this.windDirection;
    this.lavaMaterial = new SurfaceFlowNodeMaterial('lava', this.field, this.options.renderRadius, flowDirection);
    this.lavaMaterial.flowUniforms.originAlongMeters.value = this.patchCenter.clone().multiplyScalar(1 / this.meterScale)
      .sub(new Vector3(this.flowRegion.centerDirection.x, this.flowRegion.centerDirection.y, this.flowRegion.centerDirection.z)
        .multiplyScalar(this.field.radius)).dot(flowDirection);
    const mesh = new Mesh(geometryFrom(this.lava.positions, this.lava.colors, this.lava.across), this.lavaMaterial);
    mesh.name = 'surface-lava';
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    mesh.userData.anchors = this.lava.anchors;
    mesh.userData.flowSegments = this.flowSegments.filter((segment) => segment.kind === 'lava');
    mesh.userData.segmentCount = this.stats.lavaSegments;
    mesh.userData.bodyFixedCurrent = true;
    mesh.userData.geothermalPulses = true;
    this.add(mesh);
  }

  /** Weather can move living tips and visible liquid without relocating roots. */
  setWind(speedMetersPerSecond: number, bodyFixedDirection?: Vector3): void {
    this.windSpeedMetersPerSecond = Number.isFinite(speedMetersPerSecond)
      ? clamp(speedMetersPerSecond, 0, 42)
      : 0;
    if (bodyFixedDirection && bodyFixedDirection.lengthSq() > 0) {
      this.windDirection.copy(bodyFixedDirection).normalize();
    }
    this.floraMaterial?.setWind(this.windSpeedMetersPerSecond, this.windDirection);
    if (this.riverMaterial) this.riverMaterial.flowUniforms.speedMetersPerSecond.value = this.windSpeedMetersPerSecond;
    if (this.lavaMaterial) this.lavaMaterial.flowUniforms.speedMetersPerSecond.value = this.windSpeedMetersPerSecond;
    this.userData.windSpeedMetersPerSecond = this.windSpeedMetersPerSecond;
    const published = this.userData.windDirection as { x: number; y: number; z: number } | undefined;
    if (published) {
      published.x = this.windDirection.x;
      published.y = this.windDirection.y;
      published.z = this.windDirection.z;
    } else {
      this.userData.windDirection = plainDirection(this.windDirection);
    }
  }

  /** Update existing flora only from the real body-local stellar illumination. */
  setCelestialIllumination(daylight: number): void {
    this.celestialDaylight = Number.isFinite(daylight) ? clamp(daylight) : 1;
    this.floraMaterial?.setCelestialIllumination(this.celestialDaylight);
    if (this.riverMaterial) this.riverMaterial.flowUniforms.daylight.value = this.celestialDaylight;
    this.userData.celestialDaylight = this.celestialDaylight;
    this.userData.nightReactiveBioluminescence = true;
  }

  /** Animate only existing material uniforms; geometry and anchors never move. */
  update(elapsedSeconds: number): void {
    const time = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    const phase = hashUnit(this.field.seed ^ 0x3c71_aa92) * Math.PI * 2;
    if (this.riverMaterial) {
      this.riverMaterial.flowUniforms.time.value = time;
    }
    if (this.lavaMaterial) this.lavaMaterial.flowUniforms.time.value = time;
    if (this.ventMaterial) this.ventMaterial.emissiveIntensity = 1.03 + Math.sin(time * 1.9 + phase + 0.7) * 0.19;
    if (this.floraMaterial) this.floraMaterial.windUniforms.time.value = time;
  }

  dispose(): void {
    for (const child of [...this.children]) {
      this.remove(child);
      if (!(child instanceof Mesh || child instanceof InstancedMesh)) continue;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    }
    this.riverMaterial = undefined;
    this.lavaMaterial = undefined;
    this.ventMaterial = undefined;
    this.floraMaterial = undefined;
  }
}

export function createPlanetarySurfaceFeatures(
  field: PlanetField,
  options: PlanetarySurfaceFeaturesOptions,
): PlanetarySurfaceFeatures {
  return new PlanetarySurfaceFeatures(field, options);
}
