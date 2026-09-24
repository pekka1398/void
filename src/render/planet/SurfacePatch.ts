import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  TetrahedronGeometry,
  Vector3,
  type ColorRepresentation,
} from 'three';
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  float,
  fwidth,
  mix,
  modelWorldMatrix,
  positionLocal,
  positionView,
  positionWorld,
  reflect,
  select,
  smoothstep,
  uniform,
  vec3,
  vec4,
  viewZToLogarithmicDepth,
} from 'three/tsl';
import { MeshBasicNodeMaterial, type MeshLambertNodeMaterial, type Node } from 'three/webgpu';

import {
  createPlanetField,
  hashCoordinates,
  hashUnit,
  samplePlanetField,
  type PlanetField,
  type PlanetFieldInput,
} from '../../fields';
import {
  createPlanetarySurfaceFeatures,
  applyPreparedSurfaceInstances,
  LivingFloraNodeMaterial,
  PlanetarySurfaceFeatures,
} from './PlanetarySurfaceFeatures';
import type { CelestialLightFrame } from '../../lighting';
import {
  createCelestialNodeLighting,
  updateCelestialNodeLighting,
  type CelestialNodeLighting,
} from '../lighting/CelestialNodeLighting';
import { sampleSurfaceRingLighting, type PhysicalRingShadowDescriptor } from './RingDensity';
import type { PlanetWeatherNodes } from './PlanetWeatherNodes';
import { createPlanetLandMaterial } from './PlanetLandMaterial';
import { planetMeanSeaLogDepth, type PlanetOceanDepthNodes } from './PlanetOceanDepth';
import {
  SURFACE_OCEAN_BAND_FILTER,
  SURFACE_OCEAN_WAVELENGTHS_METERS,
  surfaceOceanGeometryBandWeights,
} from './SurfaceOceanSampling';
import type { ContactSurfaceGeneration } from '../../terrain/ContactGeometry';
import { createContactRenderMask, useNodeAwareMaterialCacheKey } from '../../terrain/ContactRenderMask';
import { buildSurfaceFlowRegion, isValidSurfaceFlowRegion, type SurfaceFlowRegion } from '../../terrain/SurfaceFlowField';
import {
  buildSurfacePatchGeometryBuffers,
  surfacePatchCoordinateDirection,
  SURFACE_PATCH_SEA_LEVEL_METERS,
  type SurfacePatchGeometryBuffers,
  type SurfacePatchGeometryOptions,
} from '../../terrain/SurfacePatchGeometry';
import type { TerrainJobScheduler } from '../../terrain/TerrainJobScheduler';
import {
  advanceLodProgress,
  lodIntervalContains,
  lodIntervalMask,
  sampleScreenSpaceLodNoise,
  screenSpaceLodNoise,
} from '../../terrain/TerrainLodTransition';
import {
  buildSurfaceSceneryBuffers,
  estimateSurfaceSceneryBytes,
  getSurfaceSceneryBatch,
  type SurfaceSceneryBuffers,
  type SurfaceSceneryOptions,
} from '../../terrain/SurfaceScenery';
import { createSurfaceTerrainPalette } from '../../terrain/SurfaceTerrainPresentation';
import {
  createSurfacePatchCoverage,
  createSurfacePatchCoverageMask,
  createSurfacePatchCoverageSetMask,
  surfacePatchCoverageContains,
  type SurfacePatchCoverage,
  type SurfacePatchCoverageMaskOptions,
} from './SurfacePatchCoverage';

export interface SurfacePatchOptions {
  /** Body-relative scene radius. The field still owns its real meter radius. */
  renderRadius: number;
  direction?: { x: number; y: number; z: number };
  /** Side length in camera-relative renderer units, not compressed SI meters. */
  size?: number;
  segments?: number;
  /** Set to zero on nested high-detail patches so mountain instances are not duplicated. */
  outcropCount?: number;
  mineralCount?: number;
  /** Additional body-fixed stylized flora, generated only on truthful dry terrain. */
  vegetationCount?: number;
  /** Additional body-fixed low-poly geological crystals. */
  crystalCount?: number;
  /** Additional elongated dry-land ridge formations. */
  ridgeCount?: number;
  shorelineOpacity?: number;
  /** Shared body-owned climate texture, clock, and actual stellar shadow rays. */
  weatherNodes?: PlanetWeatherNodes;
  /** Same real body-center depth node used by its globe and streamed wet tiles. */
  oceanDepth?: PlanetOceanDepthNodes;
  /** Product path: build transferable geometry in the shared terrain worker pool. */
  scheduler?: TerrainJobScheduler;
  /** Keep the full parent/proxy while this patch has no committed geometry. */
  deferGeometry?: boolean;
  /** An application may admit at most one expensive visual finalization per frame. */
  canCommit?: () => boolean;
  onCommitted?: (patch: SurfacePatch) => void;
  getContactFlowRegion?: () => SurfaceFlowRegion | null;
  /** Pending leases count too; render exclusions alone cannot own hazard lifetime. */
  hasContactLeases?: () => boolean;
}

export type SurfaceContactFlowReadiness =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly region: SurfaceFlowRegion }
  | { readonly status: 'failed'; readonly reason: string };

/** Optional raster identity for exact source-only old/new visibility probes. */
export interface SurfacePatchRasterSample {
  readonly generation: 'current' | 'retiring';
  /** Top-left physical framebuffer pixel, matching screenSpaceLodNoise. */
  readonly x: number;
  readonly y: number;
}

export interface SurfacePatchStats {
  vertices: number;
  triangles: number;
  oceanTriangles: number;
  shorelineSegments: number;
  facetSegments: number;
  waveSegments: number;
  outcrops: number;
  minerals: number;
  vegetation: number;
  crystals: number;
  ridges: number;
  decorationInstances: number;
  /** Stable actual shared-field regional biome, never a camera-local backdrop. */
  biomeId: string;
  riverSegments: number;
  lavaSegments: number;
  volcanicVents: number;
  craterInstances: number;
  ecologyFlora: number;
  ecologyRocks: number;
  ecologyDrawCalls: number;
}

const DEFAULT_DIRECTION = new Vector3(0, 1, 0);
const BODY_ROTATION_AXIS = new Vector3(0, 1, 0);
/** The signed shared field defines its physical mean sea surface at zero meters. */
export const SURFACE_OCEAN_LEVEL_METERS = SURFACE_PATCH_SEA_LEVEL_METERS;
/** Four true depth-buffer quanta survive f32 rounding on both renderer backends. */
export const SURFACE_LOG_DEPTH_QUANTUM = 4 / 16_777_216;
const SURFACE_SINGLE_DEPTH_QUANTUM = 1 / 16_777_216;
export const SURFACE_PATCH_REPLACEMENT_SECONDS = 0.32;
const SURFACE_PATCH_REPLACEMENT_NOISE_SALT = 0x5350_4c44;
const NO_SURFACE_COVERAGES: readonly SurfacePatchCoverage[] = Object.freeze([]);
const PRIMARY_SWELL_AXIS = new Vector3(0.73, 0.18, 0.66).normalize();
const SECONDARY_SWELL_AXIS = new Vector3(-0.35, 0.71, 0.61).normalize();
const WIND_CHOP_AXIS = new Vector3(0.28, 0.63, -0.72).normalize();
const PRIMARY_SWELL_AMPLITUDE_METERS = 7.4;
const SECONDARY_SWELL_AMPLITUDE_METERS = 3.35;
const WIND_CHOP_AMPLITUDE_METERS = 1.2;
const PRIMARY_SWELL_FREQUENCY = Math.PI * 2 / SURFACE_OCEAN_WAVELENGTHS_METERS[0];
const SECONDARY_SWELL_FREQUENCY = Math.PI * 2 / SURFACE_OCEAN_WAVELENGTHS_METERS[1];
const WIND_CHOP_FREQUENCY = Math.PI * 2 / SURFACE_OCEAN_WAVELENGTHS_METERS[2];
const MAXIMUM_SURFACE_WAVE_METERS =
  PRIMARY_SWELL_AMPLITUDE_METERS + SECONDARY_SWELL_AMPLITUDE_METERS + WIND_CHOP_AMPLITUDE_METERS;

export interface SurfaceOceanWaveSample {
  readonly displacementMeters: number;
  readonly maximumDisplacementMeters: number;
  readonly shorelineAttenuation: number;
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
}

/** Public aliases stay live while the actual GPU values are TSL uniform nodes. */
export interface SurfaceOceanNodeUniforms {
  time: { value: number };
  presentationOpacity: { value: number };
  patchOrigin: { value: Vector3 };
  physicalRadius: { value: number };
  metersToRender: { value: number };
  waveSeedPhase: { value: number };
  waveAmplitudes: { value: Vector3 };
  waveFrequencies: { value: Vector3 };
  geometryBandWeights: { value: Vector3 };
  geometryCellMeters: { value: number };
  exclusiveWaveDepth: { value: number };
  shallowColor: { value: Color };
  deepColor: { value: Color };
  foamColor: { value: Color };
  primaryLightDirection: { value: Vector3 };
  secondaryLightDirection: { value: Vector3 };
  tertiaryLightDirection: { value: Vector3 };
  primaryStarColor: { value: Color };
  secondaryStarColor: { value: Color };
  tertiaryStarColor: { value: Color };
  secondaryStrength: { value: number };
  tertiaryStrength: { value: number };
  primaryIrradiance: { value: number };
  secondaryIrradiance: { value: number };
  tertiaryIrradiance: { value: number };
  celestialDaylight: { value: number };
  ringOcclusion: { value: Vector3 };
  windSpeedMetersPerSecond: { value: number };
  windDirection: { value: Vector3 };
}

/** One genuine node graph compiles through both WebGPU and WebGL2 backends. */
export class SurfaceOceanNodeMaterial extends MeshBasicNodeMaterial {
  readonly uniforms: SurfaceOceanNodeUniforms;

  constructor(uniforms: SurfaceOceanNodeUniforms) {
    super({
      // colorNode already consumes the exact shared-field color attribute;
      // automatic vertex multiplication would square/darken the real water.
      vertexColors: false,
      side: DoubleSide,
      transparent: false,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: false,
    });
    this.uniforms = uniforms;
  }
}

function smoothWaveRange(edge0: number, edge1: number, value: number): number {
  const fraction = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return fraction * fraction * (3 - 2 * fraction);
}

/**
 * The actual physical field when sampleSpacingMeters is omitted. Supplying a
 * render-grid spacing mirrors its band-limited geometry without changing the
 * collision/sea datum or inventing another wave field.
 */
export function sampleSurfaceOceanWave(
  field: PlanetField,
  directionInput: { x: number; y: number; z: number },
  waterDepthMeters: number,
  elapsedSeconds: number,
  sampleSpacingMeters = 0,
): SurfaceOceanWaveSample {
  const direction = new Vector3(directionInput.x, directionInput.y, directionInput.z).normalize();
  const phase = hashUnit(field.seed ^ 0x4c51_77a3) * Math.PI * 2;
  const broad = direction.dot(PRIMARY_SWELL_AXIS) * field.radius * PRIMARY_SWELL_FREQUENCY +
    phase - elapsedSeconds * 0.84;
  const crossing = direction.dot(SECONDARY_SWELL_AXIS) * field.radius * SECONDARY_SWELL_FREQUENCY -
    phase * 0.73 + elapsedSeconds * 1.23;
  const chop = direction.dot(WIND_CHOP_AXIS) * field.radius * WIND_CHOP_FREQUENCY +
    phase * 1.41 - elapsedSeconds * 1.91;
  const actualDepth = Math.max(0, waterDepthMeters);
  const offshoreGrowth = smoothWaveRange(18, 130, actualDepth);
  const depthLimitedAmplitude = Math.min(
    actualDepth * 0.38,
    3.35 + (MAXIMUM_SURFACE_WAVE_METERS - 3.35) * offshoreGrowth,
    MAXIMUM_SURFACE_WAVE_METERS,
  );
  const maximumDisplacementMeters = depthLimitedAmplitude * smoothWaveRange(0.25, 3.5, actualDepth);
  const shorelineAttenuation = maximumDisplacementMeters / MAXIMUM_SURFACE_WAVE_METERS;
  const weights = surfaceOceanGeometryBandWeights(sampleSpacingMeters);
  const displacementMeters = (
    Math.sin(broad) * PRIMARY_SWELL_AMPLITUDE_METERS * weights[0] +
    Math.sin(crossing) * SECONDARY_SWELL_AMPLITUDE_METERS * weights[1] +
    Math.sin(chop) * WIND_CHOP_AMPLITUDE_METERS * weights[2]
  ) * shorelineAttenuation;

  const gradient = PRIMARY_SWELL_AXIS.clone()
    .multiplyScalar(Math.cos(broad) * PRIMARY_SWELL_AMPLITUDE_METERS * PRIMARY_SWELL_FREQUENCY * weights[0])
    .addScaledVector(SECONDARY_SWELL_AXIS,
      Math.cos(crossing) * SECONDARY_SWELL_AMPLITUDE_METERS * SECONDARY_SWELL_FREQUENCY * weights[1])
    .addScaledVector(WIND_CHOP_AXIS,
      Math.cos(chop) * WIND_CHOP_AMPLITUDE_METERS * WIND_CHOP_FREQUENCY * weights[2]);
  gradient.addScaledVector(direction, -gradient.dot(direction));
  const normal = direction.clone().addScaledVector(gradient, -shorelineAttenuation).normalize();

  return {
    displacementMeters,
    maximumDisplacementMeters: weights[0] === 1 && weights[1] === 1 && weights[2] === 1 ? maximumDisplacementMeters :
      (PRIMARY_SWELL_AMPLITUDE_METERS * weights[0] + SECONDARY_SWELL_AMPLITUDE_METERS * weights[1] +
        WIND_CHOP_AMPLITUDE_METERS * weights[2]) * shorelineAttenuation,
    shorelineAttenuation,
    normal: { x: normal.x, y: normal.y, z: normal.z },
  };
}

interface SurfaceOceanNodeOptions {
  readonly field: PlanetField;
  readonly patchOrigin: Vector3;
  readonly metersToRender: number;
  readonly geometryCellMeters: number;
  readonly elapsedSeconds: number;
  readonly presentationOpacity: number;
  readonly shallowColor: Color;
  readonly deepColor: Color;
  readonly foamColor: Color;
  readonly primaryLightDirection: Vector3;
  readonly secondaryLightDirection: Vector3;
  readonly tertiaryLightDirection: Vector3;
  readonly primaryStarColor: Color;
  readonly secondaryStarColor: Color;
  readonly tertiaryStarColor: Color;
  readonly secondaryStrength: number;
  readonly tertiaryStrength: number;
  readonly ringOcclusion: Vector3;
  readonly celestialLighting: CelestialNodeLighting;
  readonly weatherNodes?: PlanetWeatherNodes;
  readonly windSpeedMetersPerSecond: number;
  readonly windDirection: Vector3;
}

function createSurfaceOceanNodeMaterial(options: SurfaceOceanNodeOptions): SurfaceOceanNodeMaterial {
  // Keep the inferred uniform-node types for shader arithmetic. Their same
  // live objects are exposed through the historical `.uniforms` contract.
  const nodes = {
    time: uniform(options.elapsedSeconds),
    presentationOpacity: uniform(options.presentationOpacity),
    patchOrigin: uniform(options.patchOrigin),
    physicalRadius: uniform(options.field.radius),
    metersToRender: uniform(options.metersToRender),
    waveSeedPhase: uniform(hashUnit(options.field.seed ^ 0x4c51_77a3) * Math.PI * 2),
    waveAmplitudes: uniform(new Vector3(
      PRIMARY_SWELL_AMPLITUDE_METERS,
      SECONDARY_SWELL_AMPLITUDE_METERS,
      WIND_CHOP_AMPLITUDE_METERS,
    )),
    waveFrequencies: uniform(new Vector3(
      PRIMARY_SWELL_FREQUENCY,
      SECONDARY_SWELL_FREQUENCY,
      WIND_CHOP_FREQUENCY,
    )),
    geometryBandWeights: uniform(new Vector3(...surfaceOceanGeometryBandWeights(options.geometryCellMeters))),
    geometryCellMeters: uniform(options.geometryCellMeters),
    exclusiveWaveDepth: uniform(0),
    shallowColor: uniform(options.shallowColor),
    deepColor: uniform(options.deepColor),
    foamColor: uniform(options.foamColor),
    primaryLightDirection: uniform(options.primaryLightDirection),
    secondaryLightDirection: uniform(options.secondaryLightDirection),
    tertiaryLightDirection: uniform(options.tertiaryLightDirection),
    primaryStarColor: uniform(options.primaryStarColor),
    secondaryStarColor: uniform(options.secondaryStarColor),
    tertiaryStarColor: uniform(options.tertiaryStarColor),
    secondaryStrength: uniform(options.secondaryStrength),
    tertiaryStrength: uniform(options.tertiaryStrength),
    primaryIrradiance: options.celestialLighting.irradiance[0],
    secondaryIrradiance: options.celestialLighting.irradiance[1],
    tertiaryIrradiance: options.celestialLighting.irradiance[2],
    celestialDaylight: options.celestialLighting.daylight,
    ringOcclusion: uniform(options.ringOcclusion),
    windSpeedMetersPerSecond: uniform(options.windSpeedMetersPerSecond),
    windDirection: uniform(options.windDirection),
  };
  const material = new SurfaceOceanNodeMaterial(nodes);
  const depth = attribute<'float'>('waterDepthMeters', 'float').max(0);
  const shore = attribute<'float'>('shoreProximity', 'float').clamp(0, 1);
  const sampledWaterColor = attribute<'vec3'>('color', 'vec3');
  const bodyDirection = positionLocal.add(nodes.patchOrigin).normalize();
  const broadAxis = vec3(PRIMARY_SWELL_AXIS.x, PRIMARY_SWELL_AXIS.y, PRIMARY_SWELL_AXIS.z);
  const crossingAxis = vec3(SECONDARY_SWELL_AXIS.x, SECONDARY_SWELL_AXIS.y, SECONDARY_SWELL_AXIS.z);
  const chopAxis = vec3(WIND_CHOP_AXIS.x, WIND_CHOP_AXIS.y, WIND_CHOP_AXIS.z);

  // These phases, amplitudes, and depth limits are the authoritative physical
  // wave field. Coarse geometry only samples the bands its real grid resolves.
  const broadSwell = bodyDirection.dot(broadAxis)
    .mul(nodes.physicalRadius)
    .mul(nodes.waveFrequencies.x)
    .add(nodes.waveSeedPhase)
    .sub(nodes.time.mul(0.84));
  const crossingSwell = bodyDirection.dot(crossingAxis)
    .mul(nodes.physicalRadius)
    .mul(nodes.waveFrequencies.y)
    .sub(nodes.waveSeedPhase.mul(0.73))
    .add(nodes.time.mul(1.23));
  const windChop = bodyDirection.dot(chopAxis)
    .mul(nodes.physicalRadius)
    .mul(nodes.waveFrequencies.z)
    .add(nodes.waveSeedPhase.mul(1.41))
    .sub(nodes.time.mul(1.91));
  const maximumWave = nodes.waveAmplitudes.x
    .add(nodes.waveAmplitudes.y)
    .add(nodes.waveAmplitudes.z);
  const offshoreGrowth = smoothstep(18, 130, depth);
  const depthLimitedAmplitude = depth.mul(0.38)
    .min(mix(float(3.35), maximumWave, offshoreGrowth))
    .min(maximumWave);
  const shorelineAttenuation = depthLimitedAmplitude
    .mul(smoothstep(0.25, 3.5, depth))
    .div(maximumWave);
  const displacementMeters = broadSwell.sin()
    .mul(nodes.waveAmplitudes.x).mul(nodes.geometryBandWeights.x)
    .add(crossingSwell.sin().mul(nodes.waveAmplitudes.y).mul(nodes.geometryBandWeights.y))
    .add(windChop.sin().mul(nodes.waveAmplitudes.z).mul(nodes.geometryBandWeights.z))
    .mul(shorelineAttenuation);

  // Filter the actual phase derivative, including the formerly unfiltered
  // 440 m swell. This is directional, stable at grazing angles, and fades
  // before Nyquist. Every composed current/foam phase below uses it too.
  const phaseVisibility = (phase: Node<'float'>): Node<'float'> => float(1).sub(smoothstep(
    SURFACE_OCEAN_BAND_FILTER.fullBelowPhaseRadians,
    SURFACE_OCEAN_BAND_FILTER.hiddenAbovePhaseRadians,
    fwidth(phase).abs(),
  ));
  const broadWaveVisibility = phaseVisibility(broadSwell);
  const crossingWaveVisibility = phaseVisibility(crossingSwell);
  const shortWaveVisibility = phaseVisibility(windChop);
  const resolvedDisplacementMeters = broadSwell.sin().mul(nodes.waveAmplitudes.x).mul(broadWaveVisibility)
    .add(crossingSwell.sin().mul(nodes.waveAmplitudes.y).mul(crossingWaveVisibility))
    .add(windChop.sin().mul(nodes.waveAmplitudes.z).mul(shortWaveVisibility))
    .mul(shorelineAttenuation);

  const rawGradient = broadAxis
    .mul(broadSwell.cos())
    .mul(nodes.waveAmplitudes.x)
    .mul(nodes.waveFrequencies.x)
    .mul(broadWaveVisibility)
    .add(crossingAxis.mul(crossingSwell.cos())
      .mul(nodes.waveAmplitudes.y)
      .mul(nodes.waveFrequencies.y)
      .mul(crossingWaveVisibility))
    .add(chopAxis.mul(windChop.cos())
      .mul(nodes.waveAmplitudes.z)
      .mul(nodes.waveFrequencies.z)
      .mul(shortWaveVisibility));
  const tangentGradient = rawGradient.sub(bodyDirection.mul(rawGradient.dot(bodyDirection)));
  const bodyWaveNormal = bodyDirection
    .sub(tangentGradient.mul(shorelineAttenuation))
    .normalize();
  material.positionNode = positionLocal
    .add(bodyDirection.mul(displacementMeters).mul(nodes.metersToRender));

  // Lighting follows the moving body's same actual stars. Resolve the analytic
  // displaced normal in world space, then add only bounded capillary detail.
  const reference = select(
    bodyDirection.y.abs().greaterThan(0.92),
    vec3(1, 0, 0),
    vec3(0, 1, 0),
  );
  const tangent = reference.cross(bodyDirection).normalize();
  const bitangent = bodyDirection.cross(tangent).normalize();
  const weatherWind = nodes.windSpeedMetersPerSecond.clamp(0, 42).div(42);
  const windCurrent = bodyDirection.dot(nodes.windDirection)
    .mul(nodes.physicalRadius)
    .mul(Math.PI * 2 / 275)
    .sub(nodes.time.mul(weatherWind.mul(0.82).add(0.37)));
  const crossingCurrent = broadSwell.mul(0.59)
    .sub(crossingSwell.mul(0.43))
    .add(windCurrent.mul(0.68));
  const worldWaveNormal = modelWorldMatrix.mul(vec4(bodyWaveNormal, 0)).xyz.normalize();
  const worldTangent = modelWorldMatrix.mul(vec4(tangent, 0)).xyz.normalize();
  const worldBitangent = modelWorldMatrix.mul(vec4(bitangent, 0)).xyz.normalize();
  const primary = modelWorldMatrix.mul(vec4(nodes.primaryLightDirection, 0)).xyz.normalize();
  const secondary = modelWorldMatrix.mul(vec4(nodes.secondaryLightDirection, 0)).xyz.normalize();
  const tertiary = modelWorldMatrix.mul(vec4(nodes.tertiaryLightDirection, 0)).xyz.normalize();
  const slopeXPhase = windChop.mul(1.47).add(crossingCurrent.mul(0.51));
  const slopeYPhase = windChop.mul(1.12).sub(broadSwell.mul(0.37)).add(windCurrent.mul(0.43));
  const slopeX = slopeXPhase.cos()
    .mul(0.065)
    .mul(shorelineAttenuation.add(0.36))
    .mul(phaseVisibility(slopeXPhase));
  const slopeY = slopeYPhase.sin()
    .mul(0.061)
    .mul(shorelineAttenuation.add(0.36))
    .mul(phaseVisibility(slopeYPhase));
  const normal = worldWaveNormal
    .add(worldTangent.mul(slopeX))
    .add(worldBitangent.mul(slopeY))
    .normalize();
  const viewDirection = cameraPosition.sub(positionWorld).normalize();
  const weatherPointMeters = bodyDirection.mul(nodes.physicalRadius.add(SURFACE_OCEAN_LEVEL_METERS));
  const primaryCloudTransmission = options.weatherNodes?.cloudTransmissionNode(weatherPointMeters, 0) ?? float(1);
  const secondaryCloudTransmission = options.weatherNodes?.cloudTransmissionNode(weatherPointMeters, 1) ?? float(1);
  const tertiaryCloudTransmission = options.weatherNodes?.cloudTransmissionNode(weatherPointMeters, 2) ?? float(1);
  const primaryVisibility = float(1).sub(nodes.ringOcclusion.x.clamp(0, 0.88))
    .mul(options.celestialLighting.horizon[0])
    .mul(options.celestialLighting.eclipse[0])
    .mul(primaryCloudTransmission);
  const secondaryVisibility = float(1).sub(nodes.ringOcclusion.y.clamp(0, 0.88))
    .mul(options.celestialLighting.horizon[1])
    .mul(options.celestialLighting.eclipse[1])
    .mul(secondaryCloudTransmission);
  const tertiaryVisibility = float(1).sub(nodes.ringOcclusion.z.clamp(0, 0.88))
    .mul(options.celestialLighting.horizon[2])
    .mul(options.celestialLighting.eclipse[2])
    .mul(tertiaryCloudTransmission);
  const primaryEnergy = nodes.primaryIrradiance.clamp(0, 4).sqrt().mul(primaryVisibility);
  const secondaryEnergy = nodes.secondaryIrradiance.clamp(0, 4).sqrt().mul(secondaryVisibility)
    .mul(nodes.secondaryStrength);
  const tertiaryEnergy = nodes.tertiaryIrradiance.clamp(0, 4).sqrt().mul(tertiaryVisibility)
    .mul(nodes.tertiaryStrength);
  const primarySun = normal.dot(primary).max(0).mul(primaryEnergy);
  const secondarySun = normal.dot(secondary).max(0).mul(secondaryEnergy);
  const tertiarySun = normal.dot(tertiary).max(0).mul(tertiaryEnergy);
  const swellPhase = broadSwell.add(crossingCurrent.mul(0.23));
  const finePhase = windChop.mul(0.71).add(crossingSwell.mul(0.47)).sub(windCurrent.mul(0.35));
  const braidPhase = windCurrent.mul(0.63).sub(crossingSwell.mul(0.27));
  const swell = swellPhase.sin().mul(phaseVisibility(swellPhase));
  const fine = finePhase.sin().mul(phaseVisibility(finePhase));
  const braidedCurrent = crossingCurrent.sin().mul(phaseVisibility(crossingCurrent)).mul(0.5).add(0.5)
    .mul(braidPhase.sin().mul(phaseVisibility(braidPhase)).mul(0.5).add(0.5));
  const crestHeight = smoothstep(0.16, 0.79, resolvedDisplacementMeters.div(maximumWave.max(0.01)));
  const crests = swell.mul(0.61)
    .add(fine.mul(0.39))
    .max(0)
    .pow(3.8)
    .mul(crestHeight.mul(0.46).add(0.52))
    .mul(braidedCurrent.mul(0.42).mul(crossingWaveVisibility).add(0.57));
  const depthBlend = smoothstep(1.5, 18, depth)
    .mul(0.54)
    .add(smoothstep(18, 220, depth).mul(0.46));
  // A genuine sunset road occupies the azimuth connecting the real sun and
  // observer. At a grazing horizon the specular dot product alone stays high
  // across the whole ocean; constrain gold to this physically aligned strip.
  const surfaceUp = modelWorldMatrix.mul(vec4(bodyDirection, 0)).xyz.normalize();
  const sunAlongSurface = primary.sub(surfaceUp.mul(primary.dot(surfaceUp)));
  const viewAlongSurface = viewDirection.sub(surfaceUp.mul(viewDirection.dot(surfaceUp)));
  const reflectionAzimuth = sunAlongSurface.div(sunAlongSurface.length().max(0.00001))
    .dot(viewAlongSurface.negate().div(viewAlongSurface.length().max(0.00001)))
    .max(0);
  const sunsetCorridor = reflectionAzimuth.smoothstep(0.994, 0.99965);
  const reflectedPrimary = reflect(primary.negate(), normal)
    .dot(viewDirection)
    .max(0)
    .pow(33)
    .mul(primaryEnergy)
    .mul(sunsetCorridor.mul(0.82).add(0.18));
  const reflectedSecondary = reflect(secondary.negate(), normal)
    .dot(viewDirection)
    .max(0)
    .pow(29)
    .mul(secondaryEnergy);
  const reflectedTertiary = reflect(tertiary.negate(), normal)
    .dot(viewDirection)
    .max(0)
    .pow(33)
    .mul(tertiaryEnergy);
  // Schlick's physical water F0, shaped by the actual displaced wave normal.
  const fresnel = float(0.02).add(float(0.98).mul(float(1).sub(normal.dot(viewDirection).max(0)).pow(5)));
  const lowSun = float(1).sub(primary.dot(worldWaveNormal).abs().smoothstep(0.06, 0.48));
  const sunsetRoad = reflect(primary.negate(), normal).dot(viewDirection).max(0).pow(17)
    .mul(lowSun)
    .mul(primaryEnergy)
    .mul(sunsetCorridor)
    .mul(crests.mul(0.35).add(0.27));
  const reflectionTint = mix(vec3(0.012, 0.29, 0.34), nodes.shallowColor, shore.mul(0.27));
  const subsurfaceScatter = nodes.shallowColor.rgb
    .mul(float(1).sub(depthBlend).mul(0.095).add(0.04))
    .mul(nodes.celestialDaylight.mul(0.7).add(0.3));
  const breaking = smoothstep(0.35, 1.8, depth)
    .mul(float(1).sub(smoothstep(5, 10.5, depth)));
  const foamPhase = broadSwell.mul(1.2).sub(crossingSwell.mul(0.57)).add(windCurrent.mul(0.29));
  const crestFoam = breaking
    .mul(foamPhase
      .sin()
      .max(0)
      .pow(6)
      .mul(braidedCurrent.mul(0.13).add(0.085))
      .mul(phaseVisibility(foamPhase))
      .add(0.008))
    .add(crests.mul(float(1).sub(breaking.mul(0.76))).mul(0.018).mul(shortWaveVisibility));

  // The field already supplied the same linear macro albedo as the globe and
  // orbital water. Depth may shape nearshore optics, never repaint the ocean.
  const waterColor = sampledWaterColor
    .mul(primarySun.mul(0.53).add(secondarySun.mul(0.22)).add(tertiarySun.mul(0.16))
      .add(nodes.celestialDaylight.mul(0.19)).add(0.36))
    .mul(braidedCurrent.mul(0.055).mul(crossingWaveVisibility).add(0.935))
    .add(subsurfaceScatter)
    .add(reflectionTint.mul(crests.mul(0.13).add(fresnel.mul(crests.mul(0.085).add(0.058)))))
    .add(nodes.primaryStarColor.rgb.mul(options.celestialLighting.transmissionColors[0].rgb)
      .mul(reflectedPrimary.mul(crests.mul(0.31).add(0.11)).add(sunsetRoad.mul(0.28))))
    .add(nodes.secondaryStarColor.rgb.mul(options.celestialLighting.transmissionColors[1].rgb)
      .mul(reflectedSecondary).mul(crests.mul(0.34).add(0.15)))
    .add(nodes.tertiaryStarColor.rgb.mul(options.celestialLighting.transmissionColors[2].rgb)
      .mul(reflectedTertiary).mul(crests.mul(0.26).add(0.11)))
    .add(mix(nodes.foamColor, nodes.shallowColor, 0.33).mul(crestFoam));
  material.colorNode = options.weatherNodes?.hazeNode(
    waterColor,
    weatherPointMeters,
    1 / options.metersToRender,
  ) ?? waterColor;
  material.opacityNode = nodes.presentationOpacity;
  material.userData.shaderLanguage = 'three-shading-language';
  material.userData.sharedFieldOcean = true;
  material.userData.sharedPlanetWaterAlbedo = true;
  material.userData.analyticWaveNormals = true;
  material.userData.binaryStarReflections = true;
  material.userData.physicalCelestialSourceSlots = 3;
  material.userData.physicalSunsetReflectionRoad = true;
  material.userData.physicalSunsetReflectionAzimuth = true;
  material.userData.schlickWaterFresnel = true;
  material.userData.physicalRingShadow = true;
  material.userData.physicalCloudShadow = options.weatherNodes?.field.supported ?? false;
  material.userData.cloudShadowMode = 'source-specific-direct-light-and-reflections';
  material.userData.cloudShadowSourceSlots = 3;
  material.userData.cloudShadowSamplesPerSource = options.weatherNodes?.samplesPerSource ?? 0;
  material.userData.cloudShadowFieldSeed = options.weatherNodes?.field.seed;
  material.userData.cloudShadowClock = 'local-effects-1x';
  material.userData.heightHumidityHaze = options.weatherNodes?.field.hasAtmosphere ?? false;
  material.userData.shorelineFoam = true;
  material.userData.depthColorRampMeters = [1.5, 18, 220];
  material.userData.waveWavelengthMeters = [440, 185, 70];
  material.userData.maximumShallowWaveFraction = 0.38;
  material.userData.crossingCurrentBands = true;
  material.userData.bodyFixedWindResponse = true;
  material.userData.shoreBreakDepthMeters = [0.35, 10.5];
  material.userData.derivativeFilteredWaveBands = true;
  material.userData.waveBandFilterPhaseRadians = [Math.PI / 2, Math.PI];
  material.userData.geometryCellMeters = options.geometryCellMeters;
  material.userData.geometryWaveBandWeights = [...surfaceOceanGeometryBandWeights(options.geometryCellMeters)];
  material.userData.filtersAllOceanPhases = true;
  return material;
}

/** One bounded draw holds a layered biome-native rosette, never toy pines. */
function createShardFloraGeometry(archetype: PlanetField['archetype']): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const root = new Vector3();
  const frozen = archetype === 'frozen' || archetype === 'ice-moon';
  const desert = archetype === 'desert';
  const lush = archetype === 'temperate';
  const bladeCount = frozen ? 8 : desert ? 7 : lush ? 11 : 9;

  for (let blade = 0; blade < bladeCount; blade += 1) {
    const azimuth = blade * 2.399_963_229_728_653;
    const radial = new Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
    const sideways = new Vector3(-radial.z, 0, radial.x);
    const inner = radial.clone().multiplyScalar(0.048 + (blade % 3) * 0.05);
    const spread = frozen ? 0.37 : desert ? 0.64 : lush ? 0.77 : 0.71;
    const height = frozen ? 0.49 : desert ? 0.3 : lush ? 0.34 : 0.32;
    const tip = radial.clone().multiplyScalar(spread + (blade % 4) * (lush ? 0.15 : 0.12))
      .setY(height + ((blade * 7) % bladeCount) * (frozen ? 0.11 : desert ? 0.052 : 0.082));
    const width = (frozen ? 0.125 : desert ? 0.2 : 0.22) + (blade % 3) * 0.043;
    const left = inner.clone().addScaledVector(sideways, width).setY(0.035);
    const right = inner.clone().addScaledVector(sideways, -width).setY(0.035);
    const ridge = inner.clone().addScaledVector(radial, 0.17).setY(0.2);
    const branchRoot = ridge.clone().addScaledVector(radial, 0.1).setY(0.18);
    const branchTip = radial.clone().multiplyScalar(spread * 0.97 + (blade % 3) * 0.13)
      .addScaledVector(sideways, blade % 2 === 0 ? width * 1.7 : -width * 1.7)
      .setY(height * (lush ? 0.76 : 0.65) + (blade % 4) * 0.043);
    const branchEdge = branchRoot.clone().addScaledVector(sideways, width * (blade % 2 === 0 ? 0.72 : -0.72));
    const tones = [0.53, 0.72, 0.39, 0.62, 0.46];

    for (const [first, second, third, tone] of [
      [left, ridge, tip, tones[0]],
      [ridge, right, tip, tones[1]],
      [root, left, right, tones[2]],
      [branchRoot, branchEdge, branchTip, tones[3]],
      [branchEdge, ridge, branchTip, tones[4]],
    ] as const) {
      for (const point of [first, second, third]) {
        positions.push(point.x, point.y, point.z);
        colors.push(tone, tone * 0.86, Math.min(1, tone * 1.08));
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  geometry.userData.silhouette = 'alien-radial-shard-rosette';
  geometry.userData.bladeCount = bladeCount;
  geometry.userData.branchCount = bladeCount;
  geometry.userData.biomeArchetype = archetype;
  geometry.userData.sculpturalCanopy = true;
  geometry.userData.rootLock = true;
  return geometry;
}

/** Three asymmetric folded spires form one intentional low-poly escarpment. */
function createEscarpmentGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];

  for (const [centerX, centerZ, width, height, lean] of [
    [-0.38, 0.02, 0.59, 0.71, -0.23],
    [0.12, 0.08, 0.76, 1, 0.19],
    [0.58, -0.06, 0.46, 0.63, 0.27],
  ] as const) {
    const tip = new Vector3(centerX + lean, height, centerZ + lean * 0.36);
    const ring = [
      new Vector3(centerX - width * 0.56, 0, centerZ - width * 0.4),
      new Vector3(centerX + width * 0.61, 0, centerZ - width * 0.34),
      new Vector3(centerX + width * 0.48, 0, centerZ + width * 0.43),
      new Vector3(centerX - width * 0.64, 0, centerZ + width * 0.31),
    ];

    for (let face = 0; face < ring.length; face += 1) {
      const tone = [0.57, 0.86, 1, 0.68][face]!;
      for (const point of [ring[face]!, ring[(face + 1) % ring.length]!, tip]) {
        positions.push(point.x, point.y, point.z);
        colors.push(tone * 0.84, tone * 0.88, tone);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  geometry.userData.silhouette = 'folded-angular-geological-escarpment';
  return geometry;
}

function resolvedField(value: PlanetField | PlanetFieldInput): PlanetField {
  return 'landable' in value ? value : createPlanetField(value);
}

function coordinateDirection(
  center: Vector3,
  tangent: Vector3,
  bitangent: Vector3,
  x: number,
  y: number,
  radius: number,
): Vector3 {
  return new Vector3().copy(surfacePatchCoordinateDirection(center, tangent, bitangent, x, y, radius));
}

/** Find actual near-sea-level dry terrain without inventing a disconnected heightfield. */
export function findCoastalSurfaceDirection(
  input: PlanetField | PlanetFieldInput,
  preferredInput: { x: number; y: number; z: number } = DEFAULT_DIRECTION,
  attempts = 196,
): Vector3 {
  const field = resolvedField(input);
  const preferred = new Vector3(preferredInput.x, preferredInput.y, preferredInput.z).normalize();
  const reference = Math.abs(preferred.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const tangent = new Vector3().crossVectors(reference, preferred).normalize();
  const bitangent = new Vector3().crossVectors(preferred, tangent).normalize();
  let selected = preferred.clone();
  let best = Number.POSITIVE_INFINITY;

  for (let index = 0; index < Math.max(1, attempts); index += 1) {
    const angle = index * 2.399_963_229_728_653;
    const spread = Math.sqrt(index / Math.max(1, attempts - 1)) * 0.85;
    const candidate = preferred
      .clone()
      .addScaledVector(tangent, Math.cos(angle) * spread)
      .addScaledVector(bitangent, Math.sin(angle) * spread)
      .normalize();
    const surface = samplePlanetField(field, candidate);

    if (surface.ocean || surface.heightMeters < 5) continue;

    const score = Math.abs(surface.heightMeters - 80) + surface.slopeHint * 350;
    if (score < best) {
      selected = candidate;
      best = score;
    }
  }

  return selected;
}

interface RetiringSurfaceGround {
  readonly group: Group;
  readonly origin: Vector3;
  readonly coverage: SurfacePatchCoverage;
  readonly land: Mesh<BufferGeometry, MeshLambertNodeMaterial>;
  readonly ocean: Mesh<BufferGeometry, SurfaceOceanNodeMaterial>;
  readonly byteLength: number;
  readonly triangles: number;
}

function geometryBufferBytes(...geometries: readonly BufferGeometry[]): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const geometry of geometries) {
    const index = geometry.getIndex();
    if (index) buffers.add(index.array.buffer);
    for (const attribute of Object.values(geometry.attributes)) {
      if (attribute instanceof BufferAttribute) buffers.add(attribute.array.buffer);
    }
  }
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
}

/**
 * A genuine body-fixed near-surface neighborhood, not a camera-following fake
 * plane. Every vertex, ocean edge, and landing coordinate samples exactly the
 * same versioned spherical field used by the proxy, collision, and chunk worker.
 */
export class SurfacePatch extends Group {
  readonly field: PlanetField;
  readonly renderRadius: number;
  readonly centerDirection = new Vector3();
  readonly patchSize: number;
  readonly segments: number;
  presentationAlpha = 1;

  private readonly maxMinerals: number;
  private readonly maxOutcrops: number;
  private readonly maxVegetation: number;
  private readonly maxCrystals: number;
  private readonly maxRidges: number;
  private readonly shorelineOpacity: number;
  private readonly weatherNodes?: PlanetWeatherNodes;
  private readonly oceanDepth?: PlanetOceanDepthNodes;
  private readonly scheduler?: TerrainJobScheduler;
  private readonly canCommit?: () => boolean;
  private readonly onCommitted?: (patch: SurfacePatch) => void;
  private readonly getContactFlowRegion?: () => SurfaceFlowRegion | null;
  private readonly hasContactLeases?: () => boolean;
  private readonly jobOwner = `surface-patch-${this.id}`;
  private readonly sceneryJobOwner = `surface-scenery-${this.id}`;
  private readonly contactFlowJobOwner = `surface-contact-flow-${this.id}`;
  private jobToken = 0;
  private sceneryToken = 0;
  private sceneryGeneration = 0;
  private sceneryState: 'empty' | 'waiting' | 'queued' | 'generating' | 'ready' | 'failed' = 'empty';
  private pendingScenery?: { token: number; generation: number; options: SurfaceSceneryOptions };
  private latestSceneryOptions?: SurfaceSceneryOptions;
  private contactFlowToken = 0;
  private contactFlowState: 'empty' | 'waiting' | 'queued' | 'generating' | 'ready' | 'failed' = 'empty';
  private pendingContactFlow?: { token: number; direction: Vector3; options: SurfaceSceneryOptions };
  private preparedContactFlow?: SurfaceFlowRegion;
  private contactFlowFailure?: string;
  private sceneryGroup?: Group;
  private readonly sceneryOrigin = new Vector3();
  private readonly sceneryContactRenderMask = createContactRenderMask();
  private pendingDirection?: Vector3;
  private disposed = false;
  private committedGeneration = 0;
  private residencyAlpha = 1;
  private publishedCoverage?: SurfacePatchCoverage;
  private publishedCoverages: readonly SurfacePatchCoverage[] = NO_SURFACE_COVERAGES;
  private retiringGround?: RetiringSurfaceGround;
  private readonly replacementProgress = uniform(1);
  private readonly replacementNoiseSeed: number;
  private readonly incomingReplacementMask: Node<'bool'>;
  private readonly incomingOtherCoverageMask = createSurfacePatchCoverageMask();
  private geometryState: 'empty' | 'queued' | 'generating' | 'ready' | 'failed' = 'empty';
  private readonly weatherReceiverMeters = new Vector3();
  private weatherDebugTime = Number.NEGATIVE_INFINITY;
  private weatherDebugCelestialTime = Number.NEGATIVE_INFINITY;
  private readonly primaryLightDirection = new Vector3(0, 1, 0);
  private readonly secondaryLightDirection = new Vector3(0, 1, 0);
  private readonly tertiaryLightDirection = new Vector3(0, 1, 0);
  private readonly primaryStarColor = new Color('#FFD986');
  private readonly secondaryStarColor = new Color('#FF8C78');
  private readonly tertiaryStarColor = new Color(0, 0, 0);
  private readonly celestialLighting = createCelestialNodeLighting();
  private readonly ringOcclusion = new Vector3();
  private readonly landRingShadow = uniform(0);
  private readonly landOrigin = uniform(new Vector3());
  private readonly retiringLandOrigin = uniform(new Vector3());
  private readonly landDepthBias = uniform(SURFACE_LOG_DEPTH_QUANTUM);
  private readonly oceanDepthBias = uniform(SURFACE_LOG_DEPTH_QUANTUM * 2);
  private readonly retiringLandDepthBias = uniform(SURFACE_LOG_DEPTH_QUANTUM - SURFACE_SINGLE_DEPTH_QUANTUM);
  private readonly retiringOceanDepthBias = uniform(SURFACE_LOG_DEPTH_QUANTUM * 2 - SURFACE_SINGLE_DEPTH_QUANTUM);
  private ringDescriptor?: PhysicalRingShadowDescriptor;
  private readonly windDirection = new Vector3(1, 0, 0);
  private readonly windReference = new Vector3();
  private innerCutout?: SurfacePatch;
  private readonly innerCutoutDirection = new Vector3();
  private innerCutoutSize = 0;
  private innerCutoutCoverages: readonly SurfacePatchCoverage[] = NO_SURFACE_COVERAGES;
  private readonly innerCoverageMask = createSurfacePatchCoverageSetMask(2);
  private readonly ownOceanCoverageMask = createSurfacePatchCoverageMask();
  private readonly retiringInnerCoverageMask = createSurfacePatchCoverageSetMask(2);
  private surfaceDepthPriority = 0;
  private terrainMesh?: Mesh<BufferGeometry, MeshLambertNodeMaterial>;
  private oceanMesh?: Mesh<BufferGeometry, SurfaceOceanNodeMaterial>;
  private terrainMaterial?: MeshLambertNodeMaterial;
  private oceanMaterial?: SurfaceOceanNodeMaterial;
  private retiringTerrainMaterial?: MeshLambertNodeMaterial;
  private retiringOceanMaterial?: SurfaceOceanNodeMaterial;
  private vegetationMaterial?: LivingFloraNodeMaterial;
  private surfaceEcology?: PlanetarySurfaceFeatures;
  private pinnedFlowRegion?: SurfaceFlowRegion;
  private contactExclusions: readonly ContactSurfaceGeneration[] = [];
  private readonly contactRenderMask = createContactRenderMask();
  private readonly retiringContactRenderMask = createContactRenderMask();
  private readonly contactMaskedMaterials = new WeakSet<object>();
  private secondaryLightStrength = 0;
  private tertiaryLightStrength = 0;
  private elapsedSeconds = 0;
  private windSpeedMetersPerSecond = 0;
  private presentationMaterialsDirty = true;
  private currentStats: SurfacePatchStats = {
    vertices: 0,
    triangles: 0,
    oceanTriangles: 0,
    shorelineSegments: 0,
    facetSegments: 0,
    waveSegments: 0,
    outcrops: 0,
    minerals: 0,
    vegetation: 0,
    crystals: 0,
    ridges: 0,
    decorationInstances: 0,
    biomeId: '',
    riverSegments: 0,
    lavaSegments: 0,
    volcanicVents: 0,
    craterInstances: 0,
    ecologyFlora: 0,
    ecologyRocks: 0,
    ecologyDrawCalls: 0,
  };

  constructor(input: PlanetField | PlanetFieldInput, options: SurfacePatchOptions) {
    super();
    this.field = resolvedField(input);
    this.replacementNoiseSeed = this.field.seed ^ SURFACE_PATCH_REPLACEMENT_NOISE_SALT;
    const replacementNoise = screenSpaceLodNoise(this.replacementNoiseSeed);
    // A recentered grid has different triangle planes and can have a genuinely
    // different skyline. Keep outgoing ground opaque while incoming ground
    // reveals; a symmetric discard can punch through an old-only silhouette.
    this.incomingReplacementMask = this.incomingOtherCoverageMask.node
      .or(lodIntervalMask(replacementNoise, 0, this.replacementProgress));
    this.renderRadius = Math.max(Number.EPSILON, options.renderRadius);
    if (options.weatherNodes && (options.weatherNodes.field.seed !== this.field.seed ||
      Math.abs(options.weatherNodes.field.radiusMeters - this.field.radius) > 0.001)) {
      throw new Error('Surface weather must belong to the same actual planet field.');
    }
    this.weatherNodes = options.weatherNodes;
    this.oceanDepth = options.oceanDepth;
    this.scheduler = options.scheduler;
    this.canCommit = options.canCommit;
    this.onCommitted = options.onCommitted;
    this.getContactFlowRegion = options.getContactFlowRegion;
    this.hasContactLeases = options.hasContactLeases;
    this.residencyAlpha = options.deferGeometry ? 0 : 1;
    this.patchSize = options.size ?? Math.max(this.renderRadius * 0.34, 5);
    // 193² authoritative vertices still fit a 16-bit index; higher detail is
    // selected explicitly by the quality tier rather than every surface layer.
    this.segments = Math.max(8, Math.min(192, Math.round(options.segments ?? 68)));
    this.maxMinerals = Math.max(0, Math.min(160, options.mineralCount ?? 48));
    this.maxOutcrops = Math.max(0, Math.min(128, options.outcropCount ?? 72));
    const primaryDetail = this.maxOutcrops > 0;
    const supportsFlora = this.field.archetype !== 'volcanic' && this.field.archetype !== 'barren';
    const defaultFlora = !primaryDetail || !supportsFlora
      ? 0
      : this.field.archetype === 'frozen' || this.field.archetype === 'ice-moon'
        ? 36
        : this.field.archetype === 'desert'
          ? 45
          : 94;
    this.maxVegetation = Math.max(0, Math.min(160, options.vegetationCount ?? defaultFlora));
    this.maxCrystals = Math.max(0, Math.min(128, options.crystalCount ?? (primaryDetail ? 66 : 0)));
    this.maxRidges = Math.max(0, Math.min(64, options.ridgeCount ?? (primaryDetail ? 32 : 0)));
    this.shorelineOpacity = Math.max(0, Math.min(1, options.shorelineOpacity ?? 0.86));
    this.name = `Body-anchored coastal terrain / ${this.field.seed.toString(16)}`;
    this.userData.planetField = this.field;
    this.userData.physicalRadiusMeters = this.field.radius;
    this.userData.physicalCoverageRadiusMeters =
      this.patchSize / this.renderRadius * this.field.radius * 0.5;
    this.userData.physicalCellSizeMeters =
      this.patchSize / this.renderRadius * this.field.radius / this.segments;
    this.userData.maximumPatchSegments = 192;
    this.userData.depthPriority = 0;
    this.userData.physicalCloudShadow = this.weatherNodes?.field.supported ?? false;
    this.userData.cloudShadowMode = 'source-specific-direct-light';
    this.userData.cloudShadowSamplesPerSource = this.weatherNodes?.samplesPerSource ?? 0;
    this.userData.cloudShadowFieldSeed = this.weatherNodes?.field.seed;
    this.userData.cloudShadowClock = 'local-effects-1x';
    this.frustumCulled = false;

    const initialDirection = options.direction ?? DEFAULT_DIRECTION;
    this.centerDirection.copy(initialDirection).normalize();
    this.position.copy(this.centerDirection).multiplyScalar(this.renderRadius);
    this.landOrigin.value.copy(this.position);
    this.userData.geometryState = this.geometryState;
    this.userData.generationSerial = 0;
    this.userData.sceneryState = this.sceneryState;
    this.userData.sceneryGenerationSerial = 0;
    this.userData.contactFlowState = this.contactFlowState;
    this.userData.replacementTransitioning = false;
    this.userData.replacementProgress = 1;
    this.userData.maximumRetiringGroundGenerations = 1;
    if (!options.deferGeometry) this.recenter(initialDirection);
  }

  private geometryOptions(direction: Readonly<{ x: number; y: number; z: number }>): SurfacePatchGeometryOptions {
    return {
      renderRadius: this.renderRadius,
      direction,
      size: this.patchSize,
      segments: this.segments,
      includeOutcropFacets: this.maxOutcrops > 0,
      findShoreline: this.maxVegetation + this.maxCrystals + this.maxRidges > 0,
      mineralCandidates: this.maxMinerals > 0,
    };
  }

  /** Explicit synchronous path for deterministic fixtures and QA discontinuities. */
  recenter(directionInput: { x: number; y: number; z: number }): void {
    if (this.disposed) return;
    this.jobToken += 1;
    this.scheduler?.cancelOwner(this.jobOwner);
    this.pendingDirection = undefined;
    this.residencyAlpha = 1;
    this.finishGroundReplacement();
    this.installGeometry(buildSurfacePatchGeometryBuffers(this.field, this.geometryOptions(directionInput)), true);
  }

  /** Queue a replacement without moving or removing the currently visible surface. */
  requestRecenter(directionInput: Readonly<{ x: number; y: number; z: number }>, priority = 1_000_000): boolean {
    if (this.disposed) return false;
    const direction = new Vector3().copy(directionInput);
    if (!Number.isFinite(direction.lengthSq()) || direction.lengthSq() <= Number.EPSILON) return false;
    direction.normalize();
    const widthMeters = this.patchSize / this.renderRadius * this.field.radius;
    if (this.pendingDirection && this.pendingDirection.distanceTo(direction) * this.field.radius < widthMeters * 0.32) return false;
    if (!this.pendingDirection && this.hasGeometry && this.centerDirection.distanceToSquared(direction) < 1e-24) return false;
    if (!this.scheduler) { this.recenter(direction); return true; }
    // Prepare the second reusable node graph while work is being requested,
    // not inside the later geometry publication callback.
    if (this.hasOpaqueSurfaceDepth) this.ensureRetiringMaterials();
    const token = ++this.jobToken;
    this.scheduler.cancelOwner(this.jobOwner);
    this.pendingDirection = direction.clone();
    this.geometryState = 'queued';
    this.userData.geometryState = this.geometryState;
    const current = () => !this.disposed && this.jobToken === token;
    const failed = (error?: unknown) => {
      if (!current()) return;
      this.pendingDirection = undefined;
      this.geometryState = this.hasGeometry ? 'ready' : 'failed';
      this.userData.geometryState = this.geometryState;
      if (error) this.userData.geometryError = String(error);
    };
    const accepted = this.scheduler.scheduleSurfacePatch(this.jobOwner, {
      key: this.jobOwner, token, field: this.field, options: this.geometryOptions(direction),
    }, priority, {
      isCurrent: current,
      onStart: () => { if (current()) { this.geometryState = 'generating'; this.userData.geometryState = this.geometryState; } },
      upload: (result) => {
        if (!current() || result.token !== token) return true;
        if (this.replacementTransitioning) return false;
        if (this.canCommit && !this.canCommit()) return false;
        this.pendingDirection = undefined;
        this.installGeometry(result.buffers, false);
        return true;
      },
      onDiscard: () => failed(),
      onError: failed,
    });
    if (!accepted) failed();
    return accepted;
  }

  get hasGeometry(): boolean { return !this.disposed && this.currentStats.triangles > 0; }
  get generationSerial(): number { return this.committedGeneration; }
  get requestedDirection(): Vector3 | undefined { return this.pendingDirection?.clone(); }
  get replacementTransitioning(): boolean { return !this.disposed && this.retiringGround !== undefined; }
  /**
   * Only a single complete generation may cut its coarser fallback. Two
   * angularly overlapping grids can have different grazing-ray silhouettes,
   * so their short replacement dissolve must not claim opaque coverage.
   */
  get opaqueCoverages(): readonly SurfacePatchCoverage[] {
    return this.hasOpaqueSurfaceDepth && !this.retiringGround ? this.publishedCoverages : NO_SURFACE_COVERAGES;
  }

  /** Prepare the same visible liquid descriptors before a landing/restore takes a lease. */
  ensureContactFlowRegion(direction: Readonly<{ x: number; y: number; z: number }> = this.centerDirection): SurfaceFlowRegion | null {
    if (this.maxOutcrops === 0) return null;
    if (this.scheduler) {
      const readiness = this.resolveContactFlowRegion(direction);
      return readiness.status === 'ready' ? readiness.region : null;
    }
    if (this.pinnedFlowRegion) return this.pinnedFlowRegion;
    if (this.surfaceEcology) return this.surfaceEcology.flowRegion;
    this.pinnedFlowRegion = buildSurfaceFlowRegion(this.field, {
      centerDirection: direction,
      patchSizeMeters: this.patchSize / this.renderRadius * this.field.radius,
      maxInstances: 160,
    });
    return this.pinnedFlowRegion;
  }

  /** Actual contact jobs wait for this immutable region; no placeholder hazards are admitted. */
  resolveContactFlowRegion(directionInput: Readonly<{ x: number; y: number; z: number }>): SurfaceContactFlowReadiness {
    if (this.disposed || this.maxOutcrops === 0) return { status: 'failed', reason: 'surface-flow-owner-unavailable' };
    const direction = new Vector3().copy(directionInput);
    if (!Number.isFinite(direction.lengthSq()) || direction.lengthSq() <= Number.EPSILON) {
      return { status: 'failed', reason: 'invalid-surface-flow-direction' };
    }
    direction.normalize();
    const pinned = this.getContactFlowRegion?.();
    if (pinned) {
      this.acceptContactFlowRegion(pinned);
      return { status: 'ready', region: pinned };
    }
    const distanceLimit = Math.max(1, Math.min(8_000, this.patchSize / this.renderRadius * this.field.radius * .2));
    const nearby = (center: Readonly<{ x: number; y: number; z: number }>) =>
      direction.distanceTo(new Vector3().copy(center)) * this.field.radius <= distanceLimit;
    if (this.preparedContactFlow && nearby(this.preparedContactFlow.centerDirection)) {
      return { status: 'ready', region: this.preparedContactFlow };
    }
    const visible = this.surfaceEcology?.flowRegion;
    if (visible && nearby(visible.centerDirection)) {
      this.acceptContactFlowRegion(visible);
      return { status: 'ready', region: visible };
    }
    if (!this.scheduler) {
      const region = buildSurfaceFlowRegion(this.field, {
        centerDirection: direction, patchSizeMeters: this.patchSize / this.renderRadius * this.field.radius,
        maxInstances: 160,
      });
      this.acceptContactFlowRegion(region);
      return { status: 'ready', region };
    }
    if (this.pendingContactFlow && nearby(this.pendingContactFlow.direction)) {
      if (this.contactFlowState === 'failed') return { status: 'failed', reason: this.contactFlowFailure ?? 'surface-flow-preparation-failed' };
      this.tryScheduleContactFlow();
      return { status: 'pending' };
    }
    this.contactFlowToken += 1;
    this.scheduler.cancelOwner(this.contactFlowJobOwner);
    this.preparedContactFlow = undefined;
    this.contactFlowFailure = undefined;
    this.pendingContactFlow = {
      token: this.contactFlowToken, direction,
      options: { renderRadius: this.renderRadius, direction: { x: direction.x, y: direction.y, z: direction.z },
        size: this.patchSize, segments: this.segments, outcropCount: 0, mineralCount: 0,
        vegetationCount: 0, crystalCount: 0, ridgeCount: 0,
        includeEcology: true, ecologyMaxInstances: 160, flowOnly: true },
    };
    this.contactFlowState = 'waiting';
    this.userData.contactFlowState = this.contactFlowState;
    this.tryScheduleContactFlow();
    return { status: 'pending' };
  }

  private tryScheduleContactFlow(): void {
    const pending = this.pendingContactFlow;
    if (!this.scheduler || !pending || this.disposed || this.contactFlowState !== 'waiting') return;
    const current = () => !this.disposed && this.pendingContactFlow === pending && this.contactFlowToken === pending.token;
    const failed = (error?: unknown) => {
      if (!current()) return;
      this.contactFlowState = 'failed';
      this.contactFlowFailure = error ? String(error) : 'surface-flow-preparation-canceled';
      this.userData.contactFlowState = this.contactFlowState;
      this.userData.contactFlowError = this.contactFlowFailure;
    };
    const accepted = this.scheduler.scheduleSurfaceScenery(this.contactFlowJobOwner, {
      key: this.contactFlowJobOwner, token: pending.token, field: this.field, options: pending.options,
      contactCritical: true,
    }, Number.MAX_SAFE_INTEGER, {
      isCurrent: current,
      onStart: () => {
        if (!current()) return;
        this.contactFlowState = 'generating';
        this.userData.contactFlowState = this.contactFlowState;
      },
      upload: (result) => {
        if (!current() || result.token !== pending.token) return true;
        if (!result.buffers.flowRegion) {
          failed('surface-flow-preparation-returned-no-region');
          return true;
        }
        this.acceptContactFlowRegion(result.buffers.flowRegion, pending.token);
        return true;
      },
      onDiscard: () => failed(),
      onError: failed,
    });
    if (accepted) {
      this.contactFlowState = 'queued';
      this.userData.contactFlowState = this.contactFlowState;
    }
  }

  private acceptContactFlowRegion(region: SurfaceFlowRegion, completingToken?: number): void {
    if (!isValidSurfaceFlowRegion(region, this.field)) {
      throw new Error('Contact flow readiness belongs to a different actual planet.');
    }
    if (this.pendingContactFlow && this.pendingContactFlow.token !== completingToken) {
      this.contactFlowToken += 1;
      this.scheduler?.cancelOwner(this.contactFlowJobOwner);
    }
    this.preparedContactFlow = region;
    this.pinnedFlowRegion = region;
    this.pendingContactFlow = undefined;
    this.contactFlowState = 'ready';
    this.contactFlowFailure = undefined;
    this.userData.contactFlowState = this.contactFlowState;
    this.userData.contactFlowRegionId = region.id;
    delete this.userData.contactFlowError;
    const scenery = this.latestSceneryOptions;
    if (scenery && this.maxOutcrops > 0 && scenery.flowRegion?.id !== region.id &&
      this.surfaceEcology?.flowRegion.id !== region.id) {
      this.startSceneryPreparation({ ...scenery, flowRegion: region }, false);
    }
  }

  private releaseContactFlowSelection(): void {
    this.contactFlowToken += 1;
    this.scheduler?.cancelOwner(this.contactFlowJobOwner);
    this.pendingContactFlow = undefined;
    this.preparedContactFlow = undefined;
    this.pinnedFlowRegion = undefined;
    this.contactFlowFailure = undefined;
    this.contactFlowState = 'empty';
    this.userData.contactFlowState = this.contactFlowState;
    delete this.userData.contactFlowError;
  }

  private coverageMaskOptions(origin: Readonly<{ x: number; y: number; z: number }>,
    fullFootprint = false): SurfacePatchCoverageMaskOptions {
    const scale = this.field.radius / this.renderRadius;
    return {
      originBodyFixedMeters: { x: origin.x * scale, y: origin.y * scale, z: origin.z * scale },
      metersPerLocalUnit: scale,
      fullFootprint,
    };
  }

  private createLandMaterial(retiring: boolean): MeshLambertNodeMaterial {
    const origin = retiring ? this.retiringLandOrigin : this.landOrigin;
    const inner = retiring ? this.retiringInnerCoverageMask : this.innerCoverageMask;
    const surfaceMask = retiring ? inner.node : inner.node.and(this.incomingReplacementMask);
    const contact = retiring ? this.retiringContactRenderMask : this.contactRenderMask;
    const depthBias = retiring ? this.retiringLandDepthBias : this.landDepthBias;
    const material = createPlanetLandMaterial(this.field, {
      bodyPositionMeters: positionLocal.add(origin).mul(this.field.radius / this.renderRadius),
      metersPerRenderUnit: this.field.radius / this.renderRadius,
      weatherNodes: this.weatherNodes,
      side: DoubleSide,
      flatShading: true,
      colorNode: vec3(float(1).sub(this.landRingShadow.mul(0.82))),
      maskNode: surfaceMask.and(contact.node),
      depthNode: viewZToLogarithmicDepth(positionView.z, cameraNear, cameraFar).sub(depthBias),
    });
    material.userData.physicalRingShadow = true;
    material.userData.authoritativeContactCutout = true;
    material.userData.surfaceReplacementRole = retiring ? 'outgoing' : 'incoming';
    this.contactMaskedMaterials.add(material);
    return material;
  }

  private createOceanMaterial(retiring: boolean): SurfaceOceanNodeMaterial {
    const palette = createSurfaceTerrainPalette(this.field);
    const inner = retiring ? this.retiringInnerCoverageMask : this.innerCoverageMask;
    const material = createSurfaceOceanNodeMaterial({
      field: this.field,
      patchOrigin: this.position.clone(),
      metersToRender: this.renderRadius / this.field.radius,
      geometryCellMeters: this.patchSize * this.field.radius / this.renderRadius / this.segments,
      elapsedSeconds: this.elapsedSeconds,
      presentationOpacity: this.presentationAlpha,
      shallowColor: new Color().setRGB(...palette.nearshoreTeal),
      deepColor: new Color().setRGB(...palette.oceanIndigo),
      foamColor: new Color().setRGB(...palette.mint),
      primaryLightDirection: this.primaryLightDirection,
      secondaryLightDirection: this.secondaryLightDirection,
      tertiaryLightDirection: this.tertiaryLightDirection,
      primaryStarColor: this.primaryStarColor,
      secondaryStarColor: this.secondaryStarColor,
      tertiaryStarColor: this.tertiaryStarColor,
      secondaryStrength: this.secondaryLightStrength,
      tertiaryStrength: this.tertiaryLightStrength,
      ringOcclusion: this.ringOcclusion,
      celestialLighting: this.celestialLighting,
      weatherNodes: this.weatherNodes,
      windSpeedMetersPerSecond: this.windSpeedMetersPerSecond,
      windDirection: this.windDirection,
    });
    const actualDepth = viewZToLogarithmicDepth(positionView.z, cameraNear, cameraFar);
    const seaDepth = planetMeanSeaLogDepth(this.renderRadius,
      positionLocal.add(material.uniforms.patchOrigin as unknown as Node<'vec3'>), this.oceanDepth);
    const resolved = surfaceOceanGeometryBandWeights(
      this.patchSize * this.field.radius / this.renderRadius / this.segments).every((weight) => weight >= 1);
    const exclusive = (material.uniforms.exclusiveWaveDepth as unknown as Node<'float'>).greaterThan(0.5)
      .and(this.ownOceanCoverageMask.node.not());
    // Coarse chords and wave troughs must not compete against the mean-sea
    // fallback. True displaced depth is safe only inside a fully owned,
    // resolved current patch; the two-cell overlap keeps the common datum.
    material.depthNode = (resolved && !retiring ? select(exclusive, actualDepth, seaDepth) : seaDepth)
      .sub(retiring ? this.retiringOceanDepthBias : this.oceanDepthBias);
    material.userData.oceanDepthPolicy = resolved && !retiring
      ? 'analytic-sea-with-exclusive-resolved-waves' : 'analytic-mean-sea';
    material.userData.sharedBodyOceanDepth = Boolean(this.oceanDepth);
    material.maskNode = retiring ? inner.node : inner.node.and(this.incomingReplacementMask);
    material.userData.surfaceReplacementRole = retiring ? 'outgoing' : 'incoming';
    return material;
  }

  private ensureRetiringMaterials(): void {
    this.retiringTerrainMaterial ??= this.createLandMaterial(true);
    this.retiringOceanMaterial ??= this.createOceanMaterial(true);
    this.userData.replacementMaterialsPrepared = true;
  }

  private beginGroundReplacement(): void {
    const land = this.terrainMesh;
    const ocean = this.oceanMesh;
    const coverage = this.publishedCoverage;
    if (this.retiringGround || !land || !ocean || !coverage) return;
    this.ensureRetiringMaterials();
    const origin = this.position.clone();
    const group = new Group();
    group.name = 'Retiring body-fixed surface ground';
    group.frustumCulled = false;
    group.userData.generationSerial = this.committedGeneration;
    group.userData.origin = origin.clone();
    this.remove(land, ocean);
    land.name = 'Retiring shared-field coastal land';
    ocean.name = 'Retiring field-aligned coastal water';
    land.material = this.retiringTerrainMaterial!;
    ocean.material = this.retiringOceanMaterial!;
    land.userData.surfaceGroundGeneration = 'retiring';
    ocean.userData.surfaceGroundGeneration = 'retiring';
    group.add(land, ocean);
    this.add(group);
    this.retiringLandOrigin.value.copy(origin);
    this.retiringOceanMaterial!.uniforms.patchOrigin.value.copy(origin);
    this.retiringGround = {
      group, origin, coverage, land, ocean,
      byteLength: geometryBufferBytes(land.geometry, ocean.geometry),
      triangles: this.currentStats.triangles + this.currentStats.oceanTriangles,
    };
    this.replacementProgress.value = 0;
  }

  private updatePublishedCoverages(): void {
    const current = this.publishedCoverage;
    this.publishedCoverages = current
      ? Object.freeze(this.retiringGround ? [this.retiringGround.coverage, current] : [current])
      : NO_SURFACE_COVERAGES;
    this.userData.replacementTransitioning = this.retiringGround !== undefined;
    this.userData.replacementProgress = this.replacementProgress.value;
    this.userData.retiringGroundBytes = this.retiringGround?.byteLength ?? 0;
    this.userData.retiringGroundTriangles = this.retiringGround?.triangles ?? 0;
    this.userData.residentGroundCoverageCount = this.publishedCoverages.length;
    this.userData.replacementRetainsCoarserFallback = this.retiringGround !== undefined;
    this.updateOceanDepthOwnership();
  }

  private updateOceanDepthOwnership(): void {
    const exclusive = Boolean(this.publishedCoverage && this.presentationAlpha >= 0.995 && !this.retiringGround);
    if (this.oceanMaterial) this.oceanMaterial.uniforms.exclusiveWaveDepth.value = exclusive ? 1 : 0;
    if (this.retiringOceanMaterial) this.retiringOceanMaterial.uniforms.exclusiveWaveDepth.value = 0;
    this.userData.exclusiveOceanWaveDepth = exclusive;
  }

  private refreshReplacementCoverage(): void {
    const retiring = this.retiringGround;
    // Angular containment alone cannot prove that a displaced coarse mesh
    // covers the same oblique camera ray. Keep the established two-cell edge
    // overlap opaque; only the conservative incoming interior reveals.
    this.incomingOtherCoverageMask.set(retiring?.coverage, this.coverageMaskOptions(this.position));
  }

  private finishGroundReplacement(): void {
    const retiring = this.retiringGround;
    if (!retiring) return;
    this.remove(retiring.group);
    retiring.group.remove(retiring.land, retiring.ocean);
    retiring.land.geometry.dispose();
    retiring.ocean.geometry.dispose();
    this.retiringGround = undefined;
    this.replacementProgress.value = 1;
    this.refreshReplacementCoverage();
    this.updatePublishedCoverages();
  }

  private installGeometry(buffers: SurfacePatchGeometryBuffers, synchronousScenery: boolean): void {
    const previousTerrainMaterial = this.terrainMaterial;
    const previousOceanMaterial = this.oceanMaterial;
    if (!synchronousScenery && this.hasOpaqueSurfaceDepth &&
      this.centerDirection.distanceToSquared(buffers.centerDirection) > 1e-24) this.beginGroundReplacement();
    this.disposeGroundChildren(true);
    this.presentationMaterialsDirty = true;
    this.centerDirection.copy(buffers.centerDirection);
    this.position.copy(buffers.origin);
    this.publishedCoverage = createSurfacePatchCoverage({
      centerDirection: this.centerDirection,
      bodyRadiusMeters: this.field.radius,
      halfWidthMeters: this.patchSize / this.renderRadius * this.field.radius * 0.5,
      cellMeters: this.patchSize / this.renderRadius * this.field.radius / this.segments,
    });
    this.ownOceanCoverageMask.set(this.publishedCoverage, this.coverageMaskOptions(this.position));
    this.retiringGround?.group.position.copy(this.retiringGround.origin).sub(this.position);
    this.refreshReplacementCoverage();
    this.updatePublishedCoverages();
    // Existing scenery remains at its original planet-fixed position until a
    // replacement is ready; moving the ground origin must never drag props.
    this.sceneryGroup?.position.copy(this.sceneryOrigin).sub(this.position);
    this.landOrigin.value.copy(this.position);
    this.userData.centerDirection = this.centerDirection.clone();
    this.userData.geometryBytes = buffers.byteLength;
    const tangent = new Vector3().copy(buffers.tangent);
    this.windDirection.addScaledVector(this.centerDirection, -this.windDirection.dot(this.centerDirection));
    if (this.windDirection.lengthSq() < 0.000_01) this.windDirection.copy(tangent);
    else this.windDirection.normalize();
    this.refreshInnerCoverage();
    const centerSample = buffers.centerSample;
    this.weatherReceiverMeters.copy(this.centerDirection).multiplyScalar(
      this.field.radius + (centerSample.ocean ? SURFACE_OCEAN_LEVEL_METERS : centerSample.heightMeters),
    );
    this.weatherDebugTime = Number.NEGATIVE_INFINITY;
    const terrainPalette = buffers.palette;
    const colorFromLinear = (rgb: readonly [number, number, number]): Color => new Color().setRGB(...rgb);
    const mint = colorFromLinear(terrainPalette.mint);
    if (buffers.nearbyShoreline) this.userData.nearbyShoreline = {
      direction: new Vector3().copy(buffers.nearbyShoreline.waterward), distanceMeters: buffers.nearbyShoreline.distanceMeters,
    };
    else delete this.userData.nearbyShoreline;
    const oceanSurfacePositions = buffers.oceanPositions;
    const oceanSurfaceColors = buffers.oceanColors;
    const oceanSurfaceDepths = buffers.oceanDepths;
    const oceanSurfaceShoreProximities = buffers.oceanShoreProximities;
    const shorePositions = buffers.shorePositions;
    const facetPositions = buffers.facetPositions;
    const wavePositions = buffers.wavePositions;
    const waveColors = buffers.waveColors;
    const terrainGeometry = new BufferGeometry();
    terrainGeometry.setAttribute('position', new BufferAttribute(buffers.terrainPositions, 3));
    terrainGeometry.setAttribute('color', new BufferAttribute(buffers.terrainColors, 3));
    terrainGeometry.setAttribute('normal', new BufferAttribute(buffers.terrainNormals, 3));
    terrainGeometry.setIndex(new BufferAttribute(buffers.terrainIndices, 1));
    terrainGeometry.userData.facetTopology = 'authoritative-indexed-geological-grid';
    terrainGeometry.userData.geologicalPalette = terrainPalette.geologicalPalette;
    terrainGeometry.userData.geologicalFacetShadeRange = [...terrainPalette.geologicalFacetShadeRange];
    terrainGeometry.userData.bodyFixedSedimentaryBands = true;
    terrainGeometry.userData.collisionMatchedSlopeShading = true;
    const terrainMaterial = previousTerrainMaterial ?? this.createLandMaterial(false);
    this.terrainMaterial = terrainMaterial;
    terrainMaterial.userData.physicalRingShadow = true;
    const terrain = new Mesh(terrainGeometry, terrainMaterial);
    terrain.name = 'Shared-field faceted coastal land';
    terrain.userData.surfaceGroundGeneration = 'current';
    terrain.frustumCulled = false;
    this.terrainMesh = terrain;
    this.add(terrain);

    const oceanGeometry = new BufferGeometry();
    oceanGeometry.setAttribute(
      'position',
      new BufferAttribute(oceanSurfacePositions, 3),
    );
    oceanGeometry.setAttribute(
      'color',
      new BufferAttribute(oceanSurfaceColors, 3),
    );
    oceanGeometry.setAttribute(
      'waterDepthMeters',
      new BufferAttribute(oceanSurfaceDepths, 1),
    );
    oceanGeometry.setAttribute(
      'shoreProximity',
      new BufferAttribute(oceanSurfaceShoreProximities, 1),
    );
    oceanGeometry.userData.physicalWetMask = 'clipped-authoritative-shared-field';
    oceanGeometry.userData.physicalDepthUnit = 'meters';
    this.oceanMaterial = previousOceanMaterial ?? this.createOceanMaterial(false);
    this.oceanMaterial.uniforms.patchOrigin.value.copy(this.position);
    const ocean = new Mesh(oceanGeometry, this.oceanMaterial);
    ocean.name = 'Field-aligned teal coastal water';
    ocean.userData.surfaceGroundGeneration = 'current';
    ocean.userData.authenticDirectionalLighting = true;
    ocean.userData.sharedFieldSeed = this.field.seed;
    ocean.userData.physicallyReadableWater = true;
    ocean.userData.waveModel = 'body-fixed-multi-scale-gerstner-style';
    ocean.userData.shoreFoam = 'shared-field-depth-gradient';
    ocean.userData.maximumWaveDisplacementMeters = MAXIMUM_SURFACE_WAVE_METERS;
    ocean.userData.waveComponents = 3;
    ocean.userData.waveWavelengthMeters = [440, 185, 70];
    ocean.userData.maximumShallowWaveFraction = 0.38;
    ocean.userData.depthLimitedWaveMotion = true;
    ocean.userData.crossingCurrentBands = true;
    ocean.userData.bodyFixedWindResponse = true;
    ocean.renderOrder = 1;
    ocean.frustumCulled = false;
    this.oceanMesh = ocean;
    this.add(ocean);

    if (wavePositions.length > 0) {
      const waveGeometry = new BufferGeometry();
      waveGeometry.setAttribute('position', new BufferAttribute(new Float32Array(wavePositions), 3));
      waveGeometry.setAttribute('color', new BufferAttribute(new Float32Array(waveColors), 3));
      const waves = new LineSegments(waveGeometry, new LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.21,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }));
      waves.name = 'Shared-field body-anchored directional wet-surface wavelets';
      waves.material.maskNode = this.innerCoverageMask.node.and(this.incomingReplacementMask);
      useNodeAwareMaterialCacheKey(waves.material);
      waves.userData.sharedFieldSeed = this.field.seed;
      waves.userData.crossingCrestDirections = true;
      waves.renderOrder = 2;
      waves.frustumCulled = false;
      this.add(waves);
    }

    if (shorePositions.length > 0) {
      const shorelineGeometry = new BufferGeometry();
      shorelineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(shorePositions), 3));
      const shoreline = new LineSegments(
        shorelineGeometry,
        new LineBasicMaterial({
          color: mint,
          transparent: true,
          opacity: this.shorelineOpacity,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      shoreline.name = 'Seeded mint shoreline contours';
      shoreline.material.maskNode = this.innerCoverageMask.node.and(this.incomingReplacementMask);
      useNodeAwareMaterialCacheKey(shoreline.material);
      shoreline.frustumCulled = false;
      shoreline.renderOrder = 3;
      this.add(shoreline);
    }

    if (facetPositions.length > 0) {
      const facetGeometry = new BufferGeometry();
      facetGeometry.setAttribute(
        'position',
        new BufferAttribute(new Float32Array(facetPositions), 3),
      );
      const facets = new LineSegments(
        facetGeometry,
        new LineBasicMaterial({
          color: '#14F2EC',
          transparent: true,
          opacity: 0.84,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        }),
      );
      facets.name = 'Sparse shared-field cyan terrain facet seams';
      facets.material.maskNode = this.innerCoverageMask.node.and(this.incomingReplacementMask);
      useNodeAwareMaterialCacheKey(facets.material);
      facets.renderOrder = 2;
      facets.frustumCulled = false;
      this.add(facets);
    }

    // Ground owns its own readiness. Decorative ecology never delays a safe
    // opaque terrain publication or disposes the previous visible scenery.
    this.currentStats = {
      ...this.currentStats,
      vertices: buffers.counts.vertices,
      triangles: buffers.counts.triangles,
      oceanTriangles: oceanSurfacePositions.length / 9,
      shorelineSegments: shorePositions.length / 6,
      facetSegments: facetPositions.length / 6,
      waveSegments: wavePositions.length / 6,
      biomeId: buffers.counts.biomeId,
    };
    this.userData.stats = this.currentStats;
    this.userData.biomeId = this.currentStats.biomeId;
    this.setDepthPriority(this.surfaceDepthPriority);
    this.setPresentation(this.presentationAlpha);
    this.setContactExclusions(this.contactExclusions);
    this.committedGeneration += 1;
    this.geometryState = 'ready';
    this.userData.generationSerial = this.committedGeneration;
    this.userData.geometryState = this.geometryState;
    delete this.userData.geometryError;
    this.prepareScenery(buffers, synchronousScenery);
    this.onCommitted?.(this);
  }

  private prepareScenery(buffers: SurfacePatchGeometryBuffers, synchronous: boolean): void {
    const committedFlowRegion = this.getContactFlowRegion?.();
    if (committedFlowRegion) this.pinnedFlowRegion = committedFlowRegion;
    const options: SurfaceSceneryOptions = {
      renderRadius: this.renderRadius, direction: buffers.centerDirection,
      size: this.patchSize, segments: this.segments,
      outcropCount: this.maxOutcrops, mineralCount: this.maxMinerals,
      vegetationCount: this.maxVegetation, crystalCount: this.maxCrystals, ridgeCount: this.maxRidges,
      ...(buffers.nearbyShoreline ? { nearbyShoreline: buffers.nearbyShoreline } : {}),
      ...(this.pinnedFlowRegion ? { flowRegion: this.pinnedFlowRegion } : {}),
    };
    this.startSceneryPreparation(options, synchronous);
  }

  private startSceneryPreparation(options: SurfaceSceneryOptions, synchronous: boolean): void {
    this.sceneryToken += 1;
    this.scheduler?.cancelOwner(this.sceneryJobOwner);
    this.pendingScenery = undefined;
    this.latestSceneryOptions = options;
    if (estimateSurfaceSceneryBytes(options) === 0) {
      this.disposeScenery();
      this.sceneryState = 'empty';
      this.userData.sceneryState = this.sceneryState;
      return;
    }
    if (synchronous || !this.scheduler) {
      this.installScenery(buildSurfaceSceneryBuffers(this.field, options));
      return;
    }
    this.pendingScenery = { token: this.sceneryToken, generation: this.committedGeneration, options };
    this.sceneryState = 'waiting';
    this.userData.sceneryState = this.sceneryState;
    this.tryScheduleScenery();
  }

  /** Admission refusal is recoverable; keep the old scene and retry on a later frame. */
  private tryScheduleScenery(): void {
    const pending = this.pendingScenery;
    if (!this.scheduler || !pending || this.disposed || this.sceneryState !== 'waiting') return;
    const current = () => !this.disposed && this.pendingScenery === pending &&
      this.sceneryToken === pending.token && this.committedGeneration === pending.generation;
    const failed = (error?: unknown) => {
      if (!current()) return;
      this.pendingScenery = undefined;
      this.sceneryState = this.sceneryGroup ? 'ready' : 'failed';
      this.userData.sceneryState = this.sceneryState;
      if (error) this.userData.sceneryError = String(error);
    };
    const accepted = this.scheduler.scheduleSurfaceScenery(this.sceneryJobOwner, {
      key: this.sceneryJobOwner, token: pending.token, field: this.field, options: pending.options,
    }, 1_000, {
      isCurrent: current,
      onStart: () => {
        if (!current()) return;
        this.sceneryState = 'generating';
        this.userData.sceneryState = this.sceneryState;
      },
      upload: (result) => {
        if (!current() || result.token !== pending.token) return true;
        this.installScenery(result.buffers);
        this.pendingScenery = undefined;
        return true;
      },
      onDiscard: () => failed(),
      onError: failed,
    });
    if (accepted) {
      this.sceneryState = 'queued';
      this.userData.sceneryState = this.sceneryState;
    }
  }

  /** Publish only prepared instance buffers and small bounded primitive meshes. */
  private installScenery(buffers: SurfaceSceneryBuffers): void {
    if (buffers.fieldSeed !== this.field.seed || buffers.fieldVersion !== this.field.generatorVersion ||
      buffers.bodyRadiusMeters !== this.field.radius || buffers.renderRadius !== this.renderRadius ||
      buffers.patchSize !== this.patchSize || this.centerDirection.distanceToSquared(new Vector3().copy(buffers.centerDirection)) > 1e-20) {
      throw new Error('Prepared scenery belongs to a different physical surface generation.');
    }
    const group = new Group();
    group.name = 'Body-fixed worker-prepared surface scenery';
    group.frustumCulled = false;
    const palette = createSurfaceTerrainPalette(this.field);
    const { frozenWorld, volcanicWorld, lushWorld } = palette;
    const indigoLand = new Color().setRGB(...palette.indigoLand);
    const meterScale = this.renderRadius / this.field.radius;
    let vegetationMaterial: LivingFloraNodeMaterial | undefined;
    let ecology: PlanetarySurfaceFeatures | undefined;
    try {
      const outcropCount = getSurfaceSceneryBatch(buffers, 'outcrops').count;
      if (outcropCount > 0) {
        const mesh = new InstancedMesh(createEscarpmentGeometry(), new MeshLambertMaterial({
          color: '#FFFFFF', vertexColors: true, flatShading: true,
          emissive: frozenWorld ? '#355A83' : volcanicWorld ? '#292030' : lushWorld ? '#27544D' : '#472757',
          emissiveIntensity: frozenWorld ? .76 : volcanicWorld ? .48 : .7,
        }), outcropCount);
        applyPreparedSurfaceInstances(mesh, buffers, 'outcrops');
        mesh.name = 'Body-anchored faceted indigo mountain outcrops';
        mesh.userData.maximumPhysicalHeightMeters = 360;
        mesh.userData.maximumPhysicalDiameterMeters = 880;
        group.add(mesh);
      }
      const vegetationCount = getSurfaceSceneryBatch(buffers, 'vegetation').count;
      if (vegetationCount > 0) {
        vegetationMaterial = new LivingFloraNodeMaterial(this.field.seed ^ 0x58f1_49ab);
        vegetationMaterial.setWind(this.windSpeedMetersPerSecond, this.windDirection);
        vegetationMaterial.setCelestialIllumination(this.celestialLighting.daylight.value);
        const mesh = new InstancedMesh(createShardFloraGeometry(this.field.archetype), vegetationMaterial, vegetationCount);
        applyPreparedSurfaceInstances(mesh, buffers, 'vegetation');
        mesh.name = 'Body-anchored shared-field layered neon flora';
        mesh.userData.silhouette = 'alien-radial-shard-rosette';
        mesh.userData.instanceBudget = this.maxVegetation;
        mesh.userData.rootedWindAnimation = true;
        mesh.userData.sculpturalCanopy = true;
        group.add(mesh);
      }
      const crystalCount = getSurfaceSceneryBatch(buffers, 'crystals').count;
      if (crystalCount > 0) {
        const geometry = new OctahedronGeometry(1, 0);
        geometry.translate(0, 1, 0);
        const mesh = new InstancedMesh(geometry, new MeshLambertMaterial({
          color: '#FFFFFF', flatShading: true, emissive: indigoLand.clone().multiplyScalar(.24),
          emissiveIntensity: .2, toneMapped: true,
        }), crystalCount);
        applyPreparedSurfaceInstances(mesh, buffers, 'crystals');
        mesh.name = 'Body-anchored luminous shared-field geological crystals';
        mesh.userData.instanceBudget = this.maxCrystals;
        mesh.userData.maximumPhysicalHeightMeters = 28;
        mesh.userData.physicalStellarLighting = true;
        group.add(mesh);
      }
      const ridgeCount = getSurfaceSceneryBatch(buffers, 'ridges').count;
      if (ridgeCount > 0) {
        const mesh = new InstancedMesh(createEscarpmentGeometry(), new MeshLambertMaterial({
          color: '#FFFFFF', vertexColors: true, flatShading: true,
          emissive: frozenWorld ? '#335576' : volcanicWorld ? '#291B2F' : lushWorld ? '#26453E' : '#322346',
          emissiveIntensity: frozenWorld ? .68 : volcanicWorld ? .46 : .58,
        }), ridgeCount);
        applyPreparedSurfaceInstances(mesh, buffers, 'ridges');
        mesh.name = 'Body-anchored shared-field elongated geological ridges';
        mesh.userData.instanceBudget = this.maxRidges;
        mesh.userData.maximumPhysicalHeightMeters = 142;
        mesh.userData.maximumPhysicalHalfWidthMeters = 155;
        group.add(mesh);
      }
      const mineralCount = getSurfaceSceneryBatch(buffers, 'minerals').count;
      if (mineralCount > 0) {
        const mesh = new InstancedMesh(new TetrahedronGeometry(
          Math.min(meterScale * 10.5, Math.max(meterScale * 2.8, this.patchSize * .000_085)), 0,
        ), new MeshBasicMaterial({ color: this.field.colors.accent, toneMapped: false }), mineralCount);
        applyPreparedSurfaceInstances(mesh, buffers, 'minerals', false);
        mesh.name = 'Sparse procedural magenta mineral facets';
        group.add(mesh);
      }
      if (this.maxOutcrops > 0) {
        ecology = createPlanetarySurfaceFeatures(this.field, {
          renderRadius: this.renderRadius, centerDirection: new Vector3().copy(buffers.centerDirection),
          patchCenter: new Vector3().copy(buffers.origin), patchSize: this.patchSize, segments: this.segments,
          maxInstances: buffers.ecologyMaximumInstances, preparedScenery: buffers,
        });
        ecology.setWind(this.windSpeedMetersPerSecond, this.windDirection);
        ecology.setCelestialIllumination(this.celestialLighting.daylight.value);
        ecology.update(this.elapsedSeconds);
        group.add(ecology);
      }
    } catch (error) {
      this.disposeSceneryGroup(group);
      throw error;
    }
    const previous = this.sceneryGroup;
    this.sceneryGroup = group;
    this.sceneryOrigin.copy(buffers.origin);
    group.position.copy(this.sceneryOrigin).sub(this.position);
    this.vegetationMaterial = vegetationMaterial;
    this.surfaceEcology = ecology;
    this.add(group);
    if (previous) {
      this.remove(previous);
      this.disposeSceneryGroup(previous);
    }
    const featureStats = ecology?.stats;
    const outcrops = getSurfaceSceneryBatch(buffers, 'outcrops').count;
    const minerals = getSurfaceSceneryBatch(buffers, 'minerals').count;
    const vegetation = getSurfaceSceneryBatch(buffers, 'vegetation').count;
    const crystals = getSurfaceSceneryBatch(buffers, 'crystals').count;
    const ridges = getSurfaceSceneryBatch(buffers, 'ridges').count;
    this.currentStats = {
      ...this.currentStats, outcrops, minerals, vegetation, crystals, ridges,
      decorationInstances: outcrops + minerals + vegetation + crystals + ridges,
      riverSegments: featureStats?.riverSegments ?? 0, lavaSegments: featureStats?.lavaSegments ?? 0,
      volcanicVents: featureStats?.ventInstances ?? 0, craterInstances: featureStats?.craterInstances ?? 0,
      ecologyFlora: featureStats?.floraInstances ?? 0, ecologyRocks: featureStats?.rockInstances ?? 0,
      ecologyDrawCalls: featureStats?.drawCalls ?? 0,
    };
    this.userData.stats = this.currentStats;
    this.userData.decorationCoverageRadiusMeters = buffers.decorationCoverageRadiusMeters;
    this.userData.nearDecorationCoverageRadiusMeters = buffers.nearDecorationCoverageRadiusMeters;
    this.userData.sceneryBytes = buffers.byteLength;
    this.userData.sceneryOrigin = this.sceneryOrigin.clone();
    this.sceneryGeneration += 1;
    this.sceneryState = 'ready';
    this.userData.sceneryGenerationSerial = this.sceneryGeneration;
    this.userData.sceneryState = this.sceneryState;
    delete this.userData.sceneryError;
    this.presentationMaterialsDirty = true;
    this.setContactExclusions(this.contactExclusions);
    this.setPresentation(this.presentationAlpha);
  }

  /**
   * A committed human-scale patch owns the actual visible ground and solid
   * props inside its footprint. Keep the ocean and all distant decoration;
   * no collision readiness is inferred from this presentation mask.
   */
  setContactExclusions(generations: readonly ContactSurfaceGeneration[]): void {
    this.contactExclusions = generations.filter((generation) =>
      generation.fieldSeed === this.field.seed && generation.fieldVersion === this.field.generatorVersion &&
      Math.abs(generation.bodyRadiusMeters - this.field.radius) < 1e-6,
    ).slice(0, 2);
    const hasLeases = this.hasContactLeases?.() ?? this.contactExclusions.length > 0;
    if (hasLeases && !this.pinnedFlowRegion) {
      this.pinnedFlowRegion = this.getContactFlowRegion?.() ?? this.preparedContactFlow ?? this.surfaceEcology?.flowRegion;
    }
    if (!hasLeases) {
      this.pinnedFlowRegion = undefined;
      if (this.hasContactLeases && (this.pendingContactFlow || this.preparedContactFlow)) this.releaseContactFlowSelection();
    }
    this.contactRenderMask.set(this.contactExclusions, this.coverageMaskOptions(this.position));
    this.retiringContactRenderMask.set(this.contactExclusions,
      this.coverageMaskOptions(this.retiringGround?.origin ?? this.position));
    this.sceneryContactRenderMask.set(this.contactExclusions, this.coverageMaskOptions(this.sceneryOrigin));
    const collisionCritical = /(?:Shared-field faceted coastal land|mountain outcrops|geological crystals|geological ridges|procedural magenta mineral facets|^surface-rocks$|^surface-vents$|^surface-rivers$|^surface-lava$)/;
    this.traverse((object) => {
      if (!(object instanceof Mesh) || !collisionCritical.test(object.name)) return;
      const mask = object.name === 'Shared-field faceted coastal land'
        ? this.contactRenderMask : this.sceneryContactRenderMask;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (this.contactMaskedMaterials.has(material)) continue;
        const nodeMaterial = material as MeshLambertMaterial;
        nodeMaterial.maskNode = nodeMaterial.maskNode
          ? (nodeMaterial.maskNode as typeof mask.node).and(mask.node)
          : mask.node;
        useNodeAwareMaterialCacheKey(material);
        nodeMaterial.userData.authoritativeContactCutout = true;
        nodeMaterial.needsUpdate = true;
        this.contactMaskedMaterials.add(material);
      }
    });
    this.userData.contactExclusionGenerationIds = this.contactExclusions.map((generation) => generation.id);
    this.userData.contactExclusionPreservesOcean = true;
    this.userData.contactFlowRegionId = this.contactFlowRegion?.id;
  }

  /** Pure immutable liquid descriptors shared with contact workers and hazards. */
  get contactFlowRegion(): SurfaceFlowRegion | null {
    return this.pinnedFlowRegion ?? this.surfaceEcology?.flowRegion ?? null;
  }

  get stats(): SurfacePatchStats {
    return this.currentStats;
  }

  /** The actual published grid, never the desired center of an unfinished job. */
  get coverage(): SurfacePatchCoverage | undefined {
    return this.hasGeometry ? this.publishedCoverage : undefined;
  }

  private isGroundGenerationVisible(
    point: Readonly<{ x: number; y: number; z: number }>,
    retiring: boolean,
    ocean: boolean,
    noise?: number,
  ): boolean {
    if (this.disposed) return false;
    const coverage = retiring ? this.retiringGround?.coverage : this.coverage;
    const origin = retiring ? this.retiringGround?.origin : this.position;
    if (!coverage || !origin || !surfacePatchCoverageContains(coverage, point)) return false;
    const scale = this.field.radius / this.renderRadius;
    const local = { x: point.x / scale - origin.x, y: point.y / scale - origin.y,
      z: point.z / scale - origin.z };
    const inner = retiring ? this.retiringInnerCoverageMask : this.innerCoverageMask;
    if (!inner.isVisibleAtLocal(local)) return false;
    if (noise !== undefined && !retiring && !this.incomingOtherCoverageMask.isVisibleAtLocal(local) &&
      !lodIntervalContains(noise, 0, this.replacementProgress.value)) {
      return false;
    }
    return ocean || (retiring ? this.retiringContactRenderMask : this.contactRenderMask).isVisibleAtLocal(local);
  }

  /**
   * CPU mirror for source raycasts. Without a raster sample this asks whether
   * either real generation owns the point; a sample also checks the actual
   * pixel's incoming reveal. Retiring geometry is never partially discarded.
   */
  isTerrainVisibleAtBodyFixedMeters(point: Readonly<{ x: number; y: number; z: number }>,
    raster?: SurfacePatchRasterSample): boolean {
    if (raster) return this.isGroundGenerationVisible(point, raster.generation === 'retiring', false,
      sampleScreenSpaceLodNoise(raster.x, raster.y, this.replacementNoiseSeed));
    return this.isGroundGenerationVisible(point, false, false) ||
      this.isGroundGenerationVisible(point, true, false);
  }

  isOceanVisibleAtBodyFixedMeters(point: Readonly<{ x: number; y: number; z: number }>,
    raster?: SurfacePatchRasterSample): boolean {
    if (raster) return this.isGroundGenerationVisible(point, raster.generation === 'retiring', true,
      sampleScreenSpaceLodNoise(raster.x, raster.y, this.replacementNoiseSeed));
    return this.isGroundGenerationVisible(point, false, true) ||
      this.isGroundGenerationVisible(point, true, true);
  }

  /** True only while authentic geometry is visible and owns opaque depth. */
  get hasOpaqueSurfaceDepth(): boolean {
    return !this.disposed && this.visible && this.presentationAlpha >= 0.995 &&
      this.currentStats.triangles > 0 && this.terrainMaterial?.depthWrite === true &&
      this.terrainMaterial.transparent === false &&
      (!this.retiringGround || (this.retiringGround.land.material.depthWrite &&
        !this.retiringGround.land.material.transparent));
  }

  /** Order actual parent/child fragment depth without moving physical terrain. */
  setDepthPriority(depth: number): void {
    const priority = Number.isFinite(depth)
      ? Math.max(0, Math.min(32, Math.trunc(depth)))
      : 0;
    this.surfaceDepthPriority = priority;
    this.userData.depthPriority = priority;

    for (const [material, water, retiring] of [
      [this.terrainMaterial, false, false],
      [this.oceanMaterial, true, false],
      [this.retiringTerrainMaterial, false, true],
      [this.retiringOceanMaterial, true, true],
    ] as const) {
      if (!material) continue;
      const position = priority * 3 + (water ? 2 : 1);
      // The deliberately overlapping edge guard must not z-fight on equal
      // water planes. One real depth quantum puts the retiring mesh behind
      // the incoming one without crossing the coarser parent's priority.
      const quanta = position * 4 - (retiring ? 1 : 0);
      const bias = water
        ? retiring ? this.retiringOceanDepthBias : this.oceanDepthBias
        : retiring ? this.retiringLandDepthBias : this.landDepthBias;
      bias.value = quanta * SURFACE_SINGLE_DEPTH_QUANTUM;
      material.polygonOffset = true;
      material.polygonOffsetFactor = -position;
      material.polygonOffsetUnits = -position;
      material.userData.logarithmicDepthPriority = priority;
      material.userData.depthQuanta = quanta;
      material.userData.fragmentDepthBias = quanta / 16_777_216;
      material.userData.physicalDepthLayer = water ? 'ocean' : 'land';
      material.userData.retiringDepthSeparationQuanta = retiring ? 1 : 0;
    }
  }

  /** Fade authentic nested field meshes without dropping the parent first. */
  advancePresentation(opacity: number, deltaSeconds: number): void {
    this.tryScheduleContactFlow();
    this.tryScheduleScenery();
    if (this.retiringGround) {
      this.replacementProgress.value = advanceLodProgress(this.replacementProgress.value, 1,
        deltaSeconds, SURFACE_PATCH_REPLACEMENT_SECONDS);
      this.userData.replacementProgress = this.replacementProgress.value;
      if (this.replacementProgress.value >= 1) this.finishGroundReplacement();
    }
    if (this.hasGeometry) this.residencyAlpha = Math.min(1,
      this.residencyAlpha + Math.max(0, Math.min(.1, deltaSeconds)) / .32);
    this.userData.residencyAlpha = this.residencyAlpha;
    this.setPresentation(this.hasGeometry ? opacity * this.residencyAlpha : 0);
  }

  /** Set the exact opacity; deterministic fixtures can exercise the opaque handoff directly. */
  setPresentation(opacity: number): void {
    const next = Math.max(0, Math.min(1, opacity));
    if (!this.presentationMaterialsDirty && Math.abs(next - this.presentationAlpha) < 0.000_1) return;
    this.presentationAlpha = next;
    this.updateOceanDepthOwnership();
    this.userData.presentationAlpha = next;
    const fading = next < 0.995;

    this.traverse((object) => {
      if (!(object instanceof Mesh || object instanceof LineSegments)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const existing = material.userData.surfacePresentationBase as {
          opacity: number;
          transparent: boolean;
          depthWrite: boolean;
        } | undefined;
        const base = existing ?? {
          opacity: material.opacity,
          transparent: material.transparent,
          depthWrite: material.depthWrite,
        };
        if (!existing) material.userData.surfacePresentationBase = base;
        const transparent = base.transparent || fading;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        material.opacity = base.opacity * next;
        // During a genuine crossfade the opaque parent remains underneath;
        // the incoming child must not occlude it before the real annular
        // cutout commits near full opacity.
        material.depthWrite = base.depthWrite && !fading;
        if (material instanceof SurfaceOceanNodeMaterial) {
          material.uniforms.presentationOpacity.value = next;
        }
      }
    });

    this.presentationMaterialsDirty = false;
  }

  /** Relinquish exactly the opaque child's inset footprint without rebuilding the parent. */
  setInnerCutout(child: SurfacePatch | undefined): boolean {
    const validChild = child !== this && child &&
      child.field.seed === this.field.seed &&
      child.patchSize < this.patchSize &&
      Math.abs(child.renderRadius - this.renderRadius) < 1e-7 &&
      child.opaqueCoverages.length > 0
      ? child
      : undefined;
    const directionChanged = validChild
      ? this.innerCutoutDirection.distanceToSquared(validChild.centerDirection) > 1e-24
      : false;
    const coverages = validChild?.opaqueCoverages ?? NO_SURFACE_COVERAGES;
    if (
      validChild === this.innerCutout &&
      (validChild?.patchSize ?? 0) === this.innerCutoutSize &&
      !directionChanged && coverages === this.innerCutoutCoverages
    ) return false;

    this.innerCutout = validChild;
    this.innerCutoutSize = validChild?.patchSize ?? 0;
    if (validChild) this.innerCutoutDirection.copy(validChild.centerDirection);
    else this.innerCutoutDirection.set(0, 0, 0);
    this.refreshInnerCoverage();
    return true;
  }

  private refreshInnerCoverage(): void {
    const coverages = this.innerCutout?.opaqueCoverages ?? NO_SURFACE_COVERAGES;
    const coverage = coverages.length ? this.innerCutout?.coverage : undefined;
    this.innerCutoutCoverages = coverages;
    this.innerCoverageMask.set(coverages, this.coverageMaskOptions(this.position));
    this.retiringInnerCoverageMask.set(coverages,
      this.coverageMaskOptions(this.retiringGround?.origin ?? this.position));
    this.userData.innerCutoutMode = 'exact-gnomonic-fragment';
    this.userData.innerCutoutOrientationStretch = 1;
    this.userData.safeInscribedCutoutSizeMeters = coverage ? coverage.cutoutHalfWidthMeters * 2 : 0;
    this.userData.innerCutoutCoverageRatio = coverage ? coverage.cutoutHalfWidthMeters / coverage.halfWidthMeters : 0;
    this.userData.innerCutoutOverlapMeters = coverage?.overlapMeters ?? 0;
    this.userData.innerCutoutSizeMeters = coverage ? coverage.halfWidthMeters * 2 : 0;
    this.userData.innerCutoutChild = coverage ? this.innerCutout?.name : undefined;
    this.userData.innerCutoutCoverage = coverage;
    this.userData.innerCutoutCoverages = coverages;
    this.userData.innerCutoutCoverageCount = coverages.length;
  }

  /** Drive only rooted flora/current appearance from this body's actual wind. */
  setWind(speedMetersPerSecond: number, bodyFixedDirection?: Vector3): void {
    this.windSpeedMetersPerSecond = Number.isFinite(speedMetersPerSecond)
      ? Math.max(0, Math.min(42, speedMetersPerSecond))
      : 0;
    if (bodyFixedDirection && bodyFixedDirection.lengthSq() > 0) {
      this.windDirection.copy(bodyFixedDirection).normalize();
    }
    this.windDirection.addScaledVector(this.centerDirection, -this.windDirection.dot(this.centerDirection));
    if (this.windDirection.lengthSq() < 0.000_01) {
      this.windReference.set(0, Math.abs(this.centerDirection.y) > 0.9 ? 0 : 1,
        Math.abs(this.centerDirection.y) > 0.9 ? 1 : 0);
      this.windDirection.crossVectors(this.windReference, this.centerDirection);
    }
    this.windDirection.normalize();
    for (const material of [this.oceanMaterial, this.retiringOceanMaterial]) {
      if (!material) continue;
      material.uniforms.windSpeedMetersPerSecond.value = this.windSpeedMetersPerSecond;
      material.uniforms.windDirection.value.copy(this.windDirection);
    }
    this.vegetationMaterial?.setWind(this.windSpeedMetersPerSecond, this.windDirection);
    this.surfaceEcology?.setWind(this.windSpeedMetersPerSecond, this.windDirection);
    this.userData.windSpeedMetersPerSecond = this.windSpeedMetersPerSecond;
    const published = this.userData.bodyFixedWindDirection as Vector3 | undefined;
    if (published) published.copy(this.windDirection);
    else this.userData.bodyFixedWindDirection = this.windDirection.clone();
  }

  /** Feed the same moving stars already lighting the real planet and atmosphere. */
  setLighting(
    primaryBodyFixed: Vector3,
    secondaryBodyFixed?: Vector3,
    elapsedSeconds = 0,
    primaryColor?: ColorRepresentation,
    secondaryColor?: ColorRepresentation,
  ): void {
    this.primaryLightDirection.copy(primaryBodyFixed).normalize();
    if (secondaryBodyFixed) this.secondaryLightDirection.copy(secondaryBodyFixed).normalize();
    if (primaryColor !== undefined) this.primaryStarColor.set(primaryColor);
    if (secondaryColor !== undefined) this.secondaryStarColor.set(secondaryColor);
    this.secondaryLightStrength = secondaryBodyFixed ? 1 : 0;
    // Preserve historical callers that do not provide a complete star frame.
    this.celestialLighting.irradiance[1].value = this.secondaryLightStrength;
    this.celestialLighting.horizon[1].value = this.secondaryLightStrength;
    this.celestialLighting.eclipse[1].value = this.secondaryLightStrength;
    this.celestialLighting.transmittance[1].value = this.secondaryLightStrength;
    this.celestialLighting.transmissionColors[1].value.setRGB(
      this.secondaryLightStrength,
      this.secondaryLightStrength,
      this.secondaryLightStrength,
    );
    this.elapsedSeconds = elapsedSeconds;
    if (this.vegetationMaterial) this.vegetationMaterial.windUniforms.time.value = elapsedSeconds;
    this.surfaceEcology?.update(elapsedSeconds);
    if (this.presentationAlpha < 0.995 && this.surfaceEcology) {
      this.presentationMaterialsDirty = true;
      this.setPresentation(this.presentationAlpha);
    }
    for (const material of [this.oceanMaterial, this.retiringOceanMaterial]) {
      if (!material) continue;
      material.uniforms.secondaryStrength.value = this.secondaryLightStrength;
      material.uniforms.time.value = elapsedSeconds;
    }
  }

  /** Consume only the same real up-to-three stellar sources lighting this body. */
  setCelestialLighting(
    frame: CelestialLightFrame,
    bodyRotationRadians = 0,
    ring?: PhysicalRingShadowDescriptor,
  ): void {
    updateCelestialNodeLighting(this.celestialLighting, frame);
    this.ringDescriptor = ring;

    const directions = [this.primaryLightDirection, this.secondaryLightDirection, this.tertiaryLightDirection];
    const colors = [this.primaryStarColor, this.secondaryStarColor, this.tertiaryStarColor];
    const stellarIds = this.userData.actualStellarSourceIds as string[] | undefined;
    const sourceIds: string[] = stellarIds ?? [];
    sourceIds.length = 0;
    const surfacePoint = this.centerDirection.clone().multiplyScalar(this.field.radius);
    const ringLighting = sampleSurfaceRingLighting(surfacePoint, frame, bodyRotationRadians, ring);

    for (let index = 0; index < frame.sources.length; index += 1) {
      const source = frame.sources[index]!;
      const direction = directions[index]!;
      const color = colors[index]!;

      if (!source.active || !source.id) {
        direction.set(0, 1, 0);
        color.setRGB(0, 0, 0);
        this.ringOcclusion.setComponent(index, 0);
        continue;
      }

      sourceIds.push(source.id);
      direction.set(source.directionWorld.x, source.directionWorld.y, source.directionWorld.z)
        .applyAxisAngle(BODY_ROTATION_AXIS, -bodyRotationRadians)
        .normalize();
      if (source.colorHex) color.set(source.colorHex);
      else color.setRGB(source.spectralColor.r, source.spectralColor.g, source.spectralColor.b);

      this.ringOcclusion.setComponent(index, ringLighting.occlusions[index]!);
    }

    this.secondaryLightStrength = frame.sources[1].active ? 1 : 0;
    this.tertiaryLightStrength = frame.sources[2].active ? 1 : 0;
    const weightedOcclusion = ringLighting.weightedOcclusion;
    this.landRingShadow.value = weightedOcclusion;
    const localDaylight = ringLighting.daylight;
    this.vegetationMaterial?.setCelestialIllumination(localDaylight);
    this.surfaceEcology?.setCelestialIllumination(localDaylight);

    for (const material of [this.oceanMaterial, this.retiringOceanMaterial]) {
      if (!material) continue;
      material.uniforms.secondaryStrength.value = this.secondaryLightStrength;
      material.uniforms.tertiaryStrength.value = this.tertiaryLightStrength;
    }

    this.userData.actualStellarSourceIds = sourceIds;
    this.userData.celestialSourceCount = sourceIds.length;
    this.userData.celestialDaylight = localDaylight;
    this.userData.ringShadowFraction = weightedOcclusion;
    this.userData.physicalRingShadow = ring !== undefined;
    if (this.weatherNodes?.field.supported && (
      Math.abs(this.weatherNodes.time.value - this.weatherDebugTime) >= 0.125 ||
      Math.abs(frame.timeSeconds - this.weatherDebugCelestialTime) > 30
    )) {
      this.userData.cloudTransmission = [
        this.weatherNodes.sampleTransmission(this.weatherReceiverMeters, 0),
        this.weatherNodes.sampleTransmission(this.weatherReceiverMeters, 1),
        this.weatherNodes.sampleTransmission(this.weatherReceiverMeters, 2),
      ];
      this.userData.cloudShadowLocalEffectsSeconds = this.weatherNodes.time.value;
      this.weatherDebugTime = this.weatherNodes.time.value;
      this.weatherDebugCelestialTime = frame.timeSeconds;
    }
    this.userData.nightReactiveBioluminescence = true;
  }

  private disposeGroundChildren(preserveSurfaceMaterials = false): void {
    const terrainMaterial = this.terrainMaterial;
    const oceanMaterial = this.oceanMaterial;
    this.terrainMaterial = undefined;
    this.oceanMaterial = undefined;
    this.terrainMesh = undefined;
    this.oceanMesh = undefined;
    for (const child of [...this.children]) {
      if (child === this.sceneryGroup || child === this.retiringGround?.group) continue;
      this.remove(child);

      if (child instanceof Mesh || child instanceof LineSegments || child instanceof InstancedMesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (preserveSurfaceMaterials && (material === terrainMaterial || material === oceanMaterial)) continue;
          material.dispose();
        }
      }
    }
  }

  private disposeSceneryGroup(group: Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof PlanetarySurfaceFeatures) {
        child.dispose();
      } else if (child instanceof Mesh || child instanceof LineSegments) {
        child.geometry.dispose();
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
      }
    }
  }

  private disposeScenery(): void {
    if (this.sceneryGroup) {
      this.remove(this.sceneryGroup);
      this.disposeSceneryGroup(this.sceneryGroup);
      this.sceneryGroup = undefined;
    }
    this.vegetationMaterial = undefined;
    this.surfaceEcology = undefined;
    this.currentStats = { ...this.currentStats, outcrops: 0, minerals: 0, vegetation: 0, crystals: 0,
      ridges: 0, decorationInstances: 0, riverSegments: 0, lavaSegments: 0, volcanicVents: 0,
      craterInstances: 0, ecologyFlora: 0, ecologyRocks: 0, ecologyDrawCalls: 0 };
    this.userData.stats = this.currentStats;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobToken += 1;
    this.sceneryToken += 1;
    this.contactFlowToken += 1;
    this.pendingDirection = undefined;
    this.pendingScenery = undefined;
    this.pendingContactFlow = undefined;
    this.preparedContactFlow = undefined;
    this.scheduler?.cancelOwner(this.jobOwner);
    this.scheduler?.cancelOwner(this.sceneryJobOwner);
    this.scheduler?.cancelOwner(this.contactFlowJobOwner);
    this.finishGroundReplacement();
    this.disposeGroundChildren();
    this.disposeScenery();
    this.retiringTerrainMaterial?.dispose();
    this.retiringOceanMaterial?.dispose();
    this.retiringTerrainMaterial = undefined;
    this.retiringOceanMaterial = undefined;
    this.publishedCoverage = undefined;
    this.publishedCoverages = NO_SURFACE_COVERAGES;
  }
}

export function createSurfacePatch(
  field: PlanetField | PlanetFieldInput,
  options: SurfacePatchOptions,
): SurfacePatch {
  return new SurfacePatch(field, options);
}
