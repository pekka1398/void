import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  type ColorRepresentation,
  type MeshLambertMaterial,
} from 'three';
import {
  cameraPosition,
  float,
  mix,
  modelWorldMatrix,
  positionWorld,
  select,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  MeshLambertNodeMaterial,
  PhongLightingModel,
  type Node,
  type NodeBuilder,
  type UniformNode,
} from 'three/webgpu';

import {
  PLANET_WEATHER_SHAPING,
  type PlanetWeatherField,
} from '../../fields/PlanetWeather';
import type { Vec3Like } from '../../fields/noise';
import type { CelestialLightFrame } from '../../lighting';
import {
  createCelestialNodeLighting,
  updateCelestialNodeLighting,
  type CelestialNodeLighting,
} from '../lighting/CelestialNodeLighting';

type SourceSlot = 0 | 1 | 2;
type ScalarNode = UniformNode<'float', number>;
type DirectionNode = UniformNode<'vec3', Vector3>;
type ThreeSlots<Value> = readonly [Value, Value, Value];

export interface PlanetWeatherNodeOptions {
  readonly quality?: 'high' | 'fallback';
  readonly atmosphereColor?: ColorRepresentation;
}

export interface PlanetCloudRaySegment {
  readonly entryMeters: number;
  readonly exitMeters: number;
  readonly pathLengthMeters: number;
}

export interface PlanetWeatherNodes {
  readonly field: PlanetWeatherField;
  readonly quality: 'high' | 'fallback';
  readonly samplesPerSource: 1 | 2;
  /** One byte-exact CPU climate atlas; cloudless bodies do not allocate it. */
  readonly climateTexture: DataTexture | undefined;
  readonly time: ScalarNode;
  readonly bodyFixedStarDirections: ThreeSlots<DirectionNode>;
  readonly sourceIds: [string | undefined, string | undefined, string | undefined];
  readonly celestialLighting: CelestialNodeLighting;
  readonly hazeColor: UniformNode<'color', Color>;
  /** Normalized RGBA: humidity, coverage, orographic lift, packed elevation. */
  climateNode(bodyFixedDirection: Node<'vec3'>): Node<'vec4'>;
  densityNode(bodyFixedDirection: Node<'vec3'>): Node<'float'>;
  opticalDepthNode(bodyFixedDirection: Node<'vec3'>): Node<'float'>;
  cloudTransmissionNode(bodyPositionMeters: Node<'vec3'>, sourceIndex: SourceSlot): Node<'float'>;
  hazeFactorNode(bodyPositionMeters: Node<'vec3'>, metersPerRenderUnit: number, bodyUpWorld?: Node<'vec3'>): Node<'float'>;
  hazeNode(color: Node<'vec3'>, bodyPositionMeters: Node<'vec3'>, metersPerRenderUnit: number, bodyUpWorld?: Node<'vec3'>): Node<'vec3'>;
  sampleTransmission(bodyPositionMeters: Vec3Like, sourceIndex: SourceSlot): number;
  update(localEffectsSeconds: number, frame: CelestialLightFrame, bodyRotationRadians: number): void;
  /** Texture lifetime belongs to the actual body, never to an individual material. */
  dispose(): void;
}

const Y_AXIS = new Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;
const MAXIMUM_CLOUD_AIRMASS = 5.5;
const HIGH_SAMPLE_FRACTIONS = [0.32, 0.68] as const;
const FALLBACK_SAMPLE_FRACTIONS = [0.5] as const;

function finiteVector(input: Vec3Like): boolean {
  return Number.isFinite(input.x) && Number.isFinite(input.y) && Number.isFinite(input.z);
}

/**
 * Intersect only the first physically visible portion of a spherical cloud
 * layer. Work in planet-radius units to avoid subtracting Earth-sized squares.
 * This is an analytic shell interval, not a volumetric raymarch.
 */
export function intersectPlanetCloudLayer(
  field: Pick<PlanetWeatherField, 'supported' | 'radiusMeters' | 'cloudBaseMeters' | 'cloudTopMeters'>,
  bodyPositionMeters: Vec3Like,
  directionToStar: Vec3Like,
): PlanetCloudRaySegment | undefined {
  if (!field.supported || !finiteVector(bodyPositionMeters) || !finiteVector(directionToStar) ||
    !(field.radiusMeters > 0) || !(field.cloudTopMeters > field.cloudBaseMeters)) return undefined;

  const directionLength = Math.hypot(directionToStar.x, directionToStar.y, directionToStar.z);
  if (!(directionLength > Number.EPSILON)) return undefined;
  const inverseRadius = 1 / field.radiusMeters;
  const px = bodyPositionMeters.x * inverseRadius;
  const py = bodyPositionMeters.y * inverseRadius;
  const pz = bodyPositionMeters.z * inverseRadius;
  const dx = directionToStar.x / directionLength;
  const dy = directionToStar.y / directionLength;
  const dz = directionToStar.z / directionLength;
  const projection = px * dx + py * dy + pz * dz;
  const radiusSquared = px * px + py * py + pz * pz;
  const innerRadius = 1 + field.cloudBaseMeters * inverseRadius;
  const outerRadius = 1 + field.cloudTopMeters * inverseRadius;
  const outerDiscriminant = projection * projection - radiusSquared + outerRadius * outerRadius;
  if (outerDiscriminant < 0) return undefined;

  const outerRoot = Math.sqrt(Math.max(0, outerDiscriminant));
  let entry = Math.max(0, -projection - outerRoot);
  let exit = -projection + outerRoot;
  if (exit <= entry) return undefined;

  const innerDiscriminant = projection * projection - radiusSquared + innerRadius * innerRadius;
  if (innerDiscriminant >= 0) {
    const innerRoot = Math.sqrt(innerDiscriminant);
    const innerNear = -projection - innerRoot;
    const innerFar = -projection + innerRoot;
    if (innerNear > entry) exit = Math.min(exit, innerNear);
    else if (innerFar > entry) entry = Math.max(entry, innerFar);
  }

  if (exit <= entry) return undefined;
  return {
    entryMeters: entry * field.radiusMeters,
    exitMeters: exit * field.radiusMeters,
    pathLengthMeters: (exit - entry) * field.radiusMeters,
  };
}

/** CPU mirror of the bounded one/two-sample shader transmission. */
export function samplePlanetCloudTransmission(
  field: PlanetWeatherField,
  bodyPositionMeters: Vec3Like,
  directionToStar: Vec3Like,
  localEffectsSeconds: number,
  quality: 'high' | 'fallback' = 'high',
): number {
  const segment = intersectPlanetCloudLayer(field, bodyPositionMeters, directionToStar);
  if (!segment) return 1;
  const directionLength = Math.hypot(directionToStar.x, directionToStar.y, directionToStar.z);
  const dx = directionToStar.x / directionLength;
  const dy = directionToStar.y / directionLength;
  const dz = directionToStar.z / directionLength;
  const fractions = quality === 'fallback' ? FALLBACK_SAMPLE_FRACTIONS : HIGH_SAMPLE_FRACTIONS;
  let opticalDepth = 0;
  for (const fraction of fractions) {
    const distance = segment.entryMeters + segment.pathLengthMeters * fraction;
    opticalDepth += field.sample({
      x: bodyPositionMeters.x + dx * distance,
      y: bodyPositionMeters.y + dy * distance,
      z: bodyPositionMeters.z + dz * distance,
    }, localEffectsSeconds).opticalDepth;
  }
  const airMass = Math.min(MAXIMUM_CLOUD_AIRMASS,
    segment.pathLengthMeters / Math.max(1, field.cloudTopMeters - field.cloudBaseMeters));
  return Math.max(field.coefficients.minimumTransmission,
    Math.min(1, Math.exp(-opticalDepth / fractions.length * airMass)));
}

/** One stable graph and one modest climate texture per actual atmospheric body. */
export function createPlanetWeatherNodes(
  field: PlanetWeatherField,
  options: PlanetWeatherNodeOptions = {},
): PlanetWeatherNodes {
  const quality = options.quality ?? 'high';
  const fractions = quality === 'fallback' ? FALLBACK_SAMPLE_FRACTIONS : HIGH_SAMPLE_FRACTIONS;
  const time = uniform(0);
  const celestialLighting = createCelestialNodeLighting();
  const bodyFixedStarDirections = [
    uniform(new Vector3(0, 1, 0)),
    uniform(new Vector3(0, 1, 0)),
    uniform(new Vector3(0, 1, 0)),
  ] as const;
  const activeSources = [uniform(0), uniform(0), uniform(0)] as const;
  const atmosphereColor = new Color(options.atmosphereColor ?? '#4b9bb8');
  const hazeColor = uniform(new Color('#15172e'));
  const dawnColor = new Color();
  const coefficients = field.coefficients;
  const shape = PLANET_WEATHER_SHAPING;
  const climateTexture = field.supported
    ? new DataTexture(field.atlas.data, field.atlas.width, field.atlas.height, RGBAFormat, UnsignedByteType)
    : undefined;
  if (climateTexture) {
    climateTexture.name = `Physical climate / ${field.bodyId}`;
    climateTexture.wrapS = RepeatWrapping;
    climateTexture.wrapT = ClampToEdgeWrapping;
    climateTexture.minFilter = LinearFilter;
    climateTexture.magFilter = LinearFilter;
    climateTexture.generateMipmaps = false;
    climateTexture.flipY = false;
    climateTexture.colorSpace = NoColorSpace;
    climateTexture.needsUpdate = true;
  }

  const phase = time.mul(coefficients.windAngularVelocityRadiansPerSecond);
  const cosine = phase.cos();
  const sine = phase.sin();

  const climateNode = (rawDirection: Node<'vec3'>): Node<'vec4'> => {
    if (!climateTexture) return vec4(0);
    const direction = rawDirection.normalize();
    const uv = vec2(
      direction.x.atan(direction.z).div(TWO_PI).add(0.5),
      direction.y.clamp(-1, 1).asin().div(Math.PI).add(0.5),
    );
    return texture(climateTexture, uv);
  };

  const componentsNode = (rawDirection: Node<'vec3'>): Node<'vec3'> => {
    if (!field.supported) return vec3(0);
    const direction = rawDirection.normalize();
    const climate = climateNode(direction);
    const x = cosine.mul(direction.x).add(sine.mul(direction.z));
    const z = cosine.mul(direction.z).sub(sine.mul(direction.x));
    const first = x.mul(coefficients.frequencyA).add(z.mul(coefficients.frequencyB))
      .add(direction.y.mul(shape.latitudeA)).add(coefficients.phaseA).sin().mul(0.5).add(0.5);
    const second = z.mul(coefficients.frequencyB).sub(x.mul(coefficients.frequencyC))
      .add(direction.y.mul(shape.latitudeB)).add(coefficients.phaseB).sin().mul(0.5).add(0.5);
    const third = x.add(z).mul(coefficients.frequencyC)
      .add(direction.y.mul(shape.latitudeC)).add(coefficients.phaseC).sin().mul(0.5).add(0.5);
    const broadStructure = first.mul(shape.structureA).add(second.mul(shape.structureB))
      .add(third.mul(shape.structureC));
    const fine = x.mul(coefficients.frequencyFine)
      .add(z.mul(coefficients.frequencyFine * shape.fineCross))
      .add(direction.y.mul(shape.latitudeFine)).add(coefficients.phaseFine).sin().mul(0.5).add(0.5);
    const structure = broadStructure.mul(1 - shape.fineMix).add(fine.mul(shape.fineMix));
    const lifting = climate.r.mul(shape.liftingHumidity).add(climate.g.mul(shape.liftingCoverage))
      .add(climate.b.mul(shape.liftingOrographic));
    const threshold = float(shape.thresholdBase).sub(climate.g.mul(shape.thresholdCoverage))
      .sub(climate.r.mul(shape.thresholdHumidity)).sub(climate.b.mul(shape.thresholdOrographic))
      .clamp(0.08, 0.86);
    const presence = smoothstep(threshold, threshold.add(shape.thresholdWidth), structure);
    const density = presence.mul(structure.mul(shape.densityStructure).add(lifting.mul(shape.densityLifting)))
      .mul(climate.g).mul(coefficients.densityScale * shape.densityBoost).clamp(0, 1);
    const storm = smoothstep(coefficients.stormThreshold,
      coefficients.stormThreshold + shape.stormWidth,
      structure.mul(shape.stormStructure).add(climate.r.mul(shape.stormHumidity))
        .add(climate.b.mul(shape.stormOrographic))).mul(coefficients.stormScale);
    const opticalDepth = density.mul(coefficients.extinction)
      .mul(climate.r.mul(shape.opticalHumidity).add(storm.mul(shape.opticalStorm)).add(shape.opticalBase))
      .clamp(0, coefficients.extinction);
    return vec3(density, storm, opticalDepth);
  };

  const cloudTransmissionNode = (bodyPositionMeters: Node<'vec3'>, slot: SourceSlot): Node<'float'> => {
    if (!field.supported) return float(1);
    const point = bodyPositionMeters.div(field.radiusMeters);
    const direction = bodyFixedStarDirections[slot];
    const projection = point.dot(direction);
    const radiusSquared = point.dot(point);
    const innerRadius = 1 + field.cloudBaseMeters / field.radiusMeters;
    const outerRadius = 1 + field.cloudTopMeters / field.radiusMeters;
    const outerDiscriminant = projection.mul(projection).sub(radiusSquared).add(outerRadius * outerRadius);
    const outerRoot = outerDiscriminant.max(0).sqrt();
    const outerNear = projection.negate().sub(outerRoot).max(0);
    const outerFar = projection.negate().add(outerRoot);
    const innerDiscriminant = projection.mul(projection).sub(radiusSquared).add(innerRadius * innerRadius);
    const innerRoot = innerDiscriminant.max(0).sqrt();
    const innerNear = projection.negate().sub(innerRoot);
    const innerFar = projection.negate().add(innerRoot);
    const intersectsInner = innerDiscriminant.greaterThanEqual(0);
    const enteringInner = intersectsInner.and(innerNear.greaterThan(outerNear));
    const exitingInner = intersectsInner.and(enteringInner.not()).and(innerFar.greaterThan(outerNear));
    const entry = select(exitingInner, outerNear.max(innerFar), outerNear);
    const exit = select(enteringInner, outerFar.min(innerNear), outerFar);
    const pathLength = exit.sub(entry).max(0);
    let opticalDepth: Node<'float'> = float(0);
    for (const fraction of fractions) {
      const samplePoint = point.add(direction.mul(entry.add(pathLength.mul(fraction))));
      opticalDepth = opticalDepth.add(componentsNode(samplePoint).z);
    }
    const airMass = pathLength.mul(field.radiusMeters /
      Math.max(1, field.cloudTopMeters - field.cloudBaseMeters)).min(MAXIMUM_CLOUD_AIRMASS);
    const transmission = opticalDepth.div(fractions.length).mul(airMass).negate().exp()
      .clamp(coefficients.minimumTransmission, 1);
    const intersectsLayer = outerDiscriminant.greaterThanEqual(0)
      .and(pathLength.greaterThan(0)).and(activeSources[slot].greaterThan(0));
    return select(intersectsLayer, transmission, float(1));
  };

  const hazeFactorNode = (bodyPositionMeters: Node<'vec3'>, metersPerRenderUnit: number, bodyUpWorld?: Node<'vec3'>): Node<'float'> => {
    // A clear atmosphere still scatters light. Cloud support only controls
    // the climate texture and cloud shadows, never the existence of air.
    if (!field.hasAtmosphere) return float(0);
    const direction = bodyPositionMeters.normalize();
    const climate = climateNode(direction);
    const physicalRadius = bodyPositionMeters.length();
    // Legacy planetary meshes have body-fixed local axes. Native-meter
    // contact meshes have a tangent basis and must supply the correctly
    // transformed radial direction instead of rotating body-fixed axes twice.
    const upWorld = bodyUpWorld ?? modelWorldMatrix.mul(vec4(direction, 0)).xyz.normalize();
    const cameraDeltaMeters = cameraPosition.sub(positionWorld).mul(metersPerRenderUnit);
    const observerAltitude = upWorld.mul(physicalRadius).add(cameraDeltaMeters).length()
      .sub(field.radiusMeters).max(0);
    const surfaceAltitude = physicalRadius.sub(field.radiusMeters).max(0);
    const distanceMeters = cameraDeltaMeters.length();
    // A restrained extra near-ground air column separates distant mountain
    // silhouettes. The existing real scene fog still owns bulk visibility.
    const scaleHeight = Math.min(11_000, field.atmosphereHeightMeters * 0.22);
    const lowAir = surfaceAltitude.min(observerAltitude).div(Math.max(1, scaleHeight)).negate().exp();
    const insideAtmosphere = float(1).sub(smoothstep(
      Math.min(34_000, field.atmosphereHeightMeters * 0.72),
      Math.min(110_000, field.atmosphereHeightMeters),
      observerAltitude,
    ));
    const humidity = climate.r.mul(0.67).add(climate.b.mul(0.13)).add(0.2);
    const opticalDepth = distanceMeters.sub(4_000).max(0).div(125_000)
      .mul(lowAir).mul(humidity).mul(field.atmosphereDensity);
    return float(1).sub(opticalDepth.negate().exp())
      .mul(insideAtmosphere)
      .mul(celestialLighting.daylight.mul(0.16).add(0.08))
      .clamp(0, 0.24);
  };

  let disposed = false;
  const bridge: PlanetWeatherNodes = {
    field,
    quality,
    samplesPerSource: fractions.length as 1 | 2,
    climateTexture,
    time,
    bodyFixedStarDirections,
    sourceIds: celestialLighting.sourceIds,
    celestialLighting,
    hazeColor,
    climateNode,
    densityNode: (direction) => componentsNode(direction).x,
    opticalDepthNode: (direction) => componentsNode(direction).z,
    cloudTransmissionNode,
    hazeFactorNode,
    hazeNode: (color, bodyPositionMeters, metersPerRenderUnit, bodyUpWorld) =>
      mix(color, hazeColor, hazeFactorNode(bodyPositionMeters, metersPerRenderUnit, bodyUpWorld)),
    sampleTransmission(bodyPositionMeters, slot) {
      return activeSources[slot].value > 0
        ? samplePlanetCloudTransmission(field, bodyPositionMeters, bodyFixedStarDirections[slot].value,
          time.value, quality)
        : 1;
    },
    update(localEffectsSeconds, frame, bodyRotationRadians) {
      time.value = Number.isFinite(localEffectsSeconds) ? Math.max(0, localEffectsSeconds) : 0;
      updateCelestialNodeLighting(celestialLighting, frame);
      const rotation = Number.isFinite(bodyRotationRadians) ? bodyRotationRadians : 0;
      for (let slot = 0; slot < 3; slot += 1) {
        const source = frame.sources[slot];
        const active = Boolean(source?.active && source.id);
        activeSources[slot]!.value = active ? 1 : 0;
        bodyFixedStarDirections[slot]!.value.copy(celestialLighting.directions[slot]!.value)
          .applyAxisAngle(Y_AXIS, -rotation).normalize();
      }
      const daylight = celestialLighting.daylight.value;
      hazeColor.value.set('#100b24').lerp(atmosphereColor, 0.13 + daylight * 0.33);
      const dominant = frame.dominantSlot >= 0 ? frame.sources[frame.dominantSlot] : undefined;
      if (dominant?.active) {
        dawnColor.setRGB(
          dominant.spectralColor.r * dominant.atmosphericTransmittance.r,
          dominant.spectralColor.g * dominant.atmosphericTransmittance.g,
          dominant.spectralColor.b * dominant.atmosphericTransmittance.b,
        );
        hazeColor.value.lerp(dawnColor, Math.max(0, Math.min(1, frame.twilight)) * 0.085);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      climateTexture?.dispose();
    },
  };
  return bridge;
}

type DirectInput = Parameters<PhongLightingModel['direct']>[0];

/** Only descriptor-tagged stellar direct light is shadowed; ambient/emission stay intact. */
class WeatherLambertLightingModel extends PhongLightingModel {
  constructor(private readonly transmission: Node<'vec3'>) {
    super(false);
  }

  override direct(lightData: DirectInput, builder: NodeBuilder): void {
    const sourceSlot = (lightData.lightNode as unknown as {
      light?: { userData?: { celestialSourceSlot?: unknown } };
    }).light?.userData?.celestialSourceSlot;
    const transmission = sourceSlot === 0 ? this.transmission.x
      : sourceSlot === 1 ? this.transmission.y
        : sourceSlot === 2 ? this.transmission.z
          : undefined;
    super.direct(transmission
      ? { ...lightData, lightColor: vec3(lightData.lightColor as Node<'vec3'>).mul(transmission) }
      : lightData, builder);
  }
}

export interface PlanetWeatherLambertOptions {
  /** Actual body-fixed physical position of this fragment, in meters. */
  readonly bodyPositionMeters: Node<'vec3'>;
  readonly metersPerRenderUnit: number;
  /** Optional actual world radial direction for meshes whose local axes are tangent-fixed. */
  readonly bodyUpWorld?: Node<'vec3'>;
  readonly haze?: boolean;
}

type WeatherLambertMaterial = (MeshLambertMaterial | MeshLambertNodeMaterial) & {
  setupLightingModel?: () => PhongLightingModel;
  setupOutput?: (builder: NodeBuilder, outputNode: Node) => Node;
  planetWeatherTransmissionNode?: Node<'vec3'>;
  planetWeatherHazeFactorNode?: Node<'float'>;
  planetWeatherHazeColorNode?: Node<'color'>;
};

/**
 * Keep native Lambert shading, flat/Gouraud normals, vertex colors, emission,
 * ring shadows, and scene fog. Three's supported setupLightingModel hook lets
 * the same real source lose only its own direct energy, without shadow maps.
 * Enumerable hooks also survive NodeLibrary's legacy Lambert conversion.
 */
export function applyPlanetWeatherToLambertMaterial<Material extends MeshLambertMaterial | MeshLambertNodeMaterial>(
  material: Material,
  bridge: PlanetWeatherNodes,
  options: PlanetWeatherLambertOptions,
): Material {
  if (!bridge.field.hasAtmosphere) return material;
  const weatherMaterial = material as WeatherLambertMaterial;
  if (bridge.field.supported) {
    const transmission = vec3(
      bridge.cloudTransmissionNode(options.bodyPositionMeters, 0),
      bridge.cloudTransmissionNode(options.bodyPositionMeters, 1),
      bridge.cloudTransmissionNode(options.bodyPositionMeters, 2),
    );
    // Own node properties also make the native NodeMaterial program cache
    // aware of the shared weather graph and its planet-specific texture.
    weatherMaterial.planetWeatherTransmissionNode = transmission;
    const lightingModel = new WeatherLambertLightingModel(transmission);
    weatherMaterial.setupLightingModel = () => lightingModel;
    material.userData.cloudShadowMode = 'source-specific-direct-light';
    material.userData.cloudShadowSourceSlots = 3;
    material.userData.cloudShadowSamplesPerSource = bridge.samplesPerSource;
    material.userData.cloudShadowFieldSeed = bridge.field.seed;
    material.userData.cloudShadowBodyId = bridge.field.bodyId;
    material.userData.cloudShadowClock = 'local-effects-1x';
  }
  if (options.haze !== false) {
    const factor = bridge.hazeFactorNode(options.bodyPositionMeters, options.metersPerRenderUnit, options.bodyUpWorld);
    const nativeSetupOutput = weatherMaterial.setupOutput ?? MeshLambertNodeMaterial.prototype.setupOutput;
    weatherMaterial.planetWeatherHazeFactorNode = factor;
    weatherMaterial.planetWeatherHazeColorNode = bridge.hazeColor;
    weatherMaterial.setupOutput = function (builder, outputNode) {
      const output = vec4(outputNode as Node<'vec4'>);
      return nativeSetupOutput.call(this, builder,
        vec4(mix(output.rgb, bridge.hazeColor, factor), output.a));
    };
  }
  material.userData.physicalCloudShadow = bridge.field.supported;
  material.userData.heightHumidityHaze = options.haze !== false;
  material.needsUpdate = true;
  return material;
}
