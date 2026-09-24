import * as THREE from 'three';
import {
  cameraPosition,
  float,
  instancedDynamicBufferAttribute,
  normalWorldGeometry,
  positionGeometry,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';

import { hashUnit, samplePlanetClimate, type PlanetField, type PlanetSurfaceSample } from '../../fields';
import type { PlanetWeatherField, PlanetWeatherSample } from '../../fields/PlanetWeather';
import {
  hasRenderableAtmosphere,
  PLANET_CLOUD_TERRAIN_CLEARANCE_METERS,
  sampleAtmosphereDensity,
  supportsAtmosphericClouds,
  type PlanetDescriptor,
} from '../../universe';
import type { CelestialNodeLighting } from '../lighting/CelestialNodeLighting';
import type { PlanetWeatherNodes } from './PlanetWeatherNodes';
import { planetCloudAppearance } from './PlanetCloudAppearance';
import {
  CLOUD_RESIDENCY_LIMITS,
  CloudRegionResidency,
  createCloudCellGrid,
  type CloudCell,
  type CloudResidencyLayer,
} from './CloudResidency';

const WEATHER_CELL_METERS = CLOUD_RESIDENCY_LIMITS.nearCellMeters;
const MAX_NEAR_CLUSTERS = CLOUD_RESIDENCY_LIMITS.nearSlots;
const MAX_FAR_CLUSTERS = CLOUD_RESIDENCY_LIMITS.farSlots;
const FAR_WEATHER_CELL_STRIDE = CLOUD_RESIDENCY_LIMITS.farCellMeters / WEATHER_CELL_METERS;
const FAR_WEATHER_RADIUS_METERS = WEATHER_CELL_METERS * FAR_WEATHER_CELL_STRIDE * Math.sqrt(13);
const LOCAL_CLOUD_PREWARM_ATMOSPHERE = 1.35;
const LOCAL_CLOUD_FADE_START_ATMOSPHERE = 0.84;
const LOCAL_CLOUD_FADE_END_ATMOSPHERE = 1.12;

export interface PlanetWeatherState {
  readonly hasAtmosphere: boolean;
  /** Whether a physical cloud layer can form, not whether the body has air. */
  readonly supported: boolean;
  readonly bodyId: string;
  atmosphericDensity: number;
  cloudDensity: number;
  insideCloud: boolean;
  readonly cloudBaseMeters: number;
  readonly cloudTopMeters: number;
  /** Signed radial altitude relative to this body's mean-sea datum. */
  observerAltitudeMeters: number;
  localMoisture: number;
  cloudCoverage: number;
  cellKey: string;
  localClusterCount: number;
  nearClusterCount: number;
  farClusterCount: number;
  rareFormationCount: number;
  precipitation: number;
  surfaceClearanceMeters: number;
  opticalDepth: number;
  weatherPhase: number;
  stormIntensity: number;
  weatherFieldDensity: number;
  weatherEpochSeconds: number;
  readonly windSpeedMetersPerSecond: number;
}

export interface AtmosphericWeatherLighting {
  readonly primary: THREE.Vector3;
  readonly secondary: THREE.Vector3;
  readonly primaryColor: THREE.Color;
  readonly secondaryColor: THREE.Color;
  readonly secondaryStrength: { value: number };
  readonly celestial?: CelestialNodeLighting;
}

export interface AtmosphericWeatherOptions {
  /** The one authoritative, body-fixed weather field shared with terrain. */
  readonly weatherField?: PlanetWeatherField;
  /** Stable TSL bridge driven once per rendered frame by the owning body. */
  readonly weatherNodes?: PlanetWeatherNodes;
}

interface AtmosphericWeatherUniforms {
  primaryLightDirection: { value: THREE.Vector3 };
  secondaryLightDirection: { value: THREE.Vector3 };
  tertiaryLightDirection: { value: THREE.Vector3 };
  primaryStarColor: { value: THREE.Color };
  secondaryStarColor: { value: THREE.Color };
  tertiaryStarColor: { value: THREE.Color };
  primaryTransmissionColor: { value: THREE.Color };
  secondaryTransmissionColor: { value: THREE.Color };
  tertiaryTransmissionColor: { value: THREE.Color };
  primaryIrradiance: { value: number };
  secondaryIrradiance: { value: number };
  tertiaryIrradiance: { value: number };
  primaryHorizonVisibility: { value: number };
  secondaryHorizonVisibility: { value: number };
  tertiaryHorizonVisibility: { value: number };
  primaryTransmittance: { value: number };
  secondaryTransmittance: { value: number };
  tertiaryTransmittance: { value: number };
  primaryEclipseVisibility: { value: number };
  secondaryEclipseVisibility: { value: number };
  tertiaryEclipseVisibility: { value: number };
  celestialDaylight: { value: number };
  activeCelestialSources: { value: number };
  secondaryStrength: { value: number };
  horizonColor: { value: THREE.Color };
  twilightColor: { value: THREE.Color };
  layerOpacity: { value: number };
  presentationOpacity: { value: number };
  observerDensity: { value: number };
  cloudDensity: { value: number };
  groundVisibility: { value: number };
  weatherHumidity: { value: number };
  opticalDepth: { value: number };
  stormIntensity: { value: number };
  weatherFieldDensity: { value: number };
  windPhase: { value: number };
  time: { value: number };
}

type AtmosphericWeatherMaterial = MeshBasicNodeMaterial & {
  readonly uniforms: AtmosphericWeatherUniforms;
};

interface WeatherClusterAnchor {
  readonly id: string;
  direction: { x: number; y: number; z: number };
  altitudeMeters: number;
  terrainHeightMeters: number;
  horizontalRadiusMeters: number;
  verticalRadiusMeters: number;
  humidity: number;
  density: number;
  layer: 'near' | 'far';
  formation: 'bank' | 'anvil' | 'tower';
  stormIntensity?: number;
  weatherFieldDensity?: number;
}

interface WeatherFormation {
  readonly id: string;
  readonly direction: WeatherClusterAnchor['direction'];
  readonly anchor: WeatherClusterAnchor;
  readonly matrix: THREE.Matrix4;
  readonly color: THREE.Color;
}

interface ExtendedWeatherSample extends PlanetSurfaceSample {
  readonly cloudCoverage?: number;
  readonly weatherHumidity?: number;
}

function weatherSample(field: PlanetField, direction: THREE.Vector3): ExtendedWeatherSample {
  // The cloud consumer needs exact height/climate, never river-heading probes.
  return samplePlanetClimate(field, direction) as ExtendedWeatherSample;
}

/** Mean sea is the weather envelope only where the authoritative surface is wet. */
export function weatherSurfaceHeightMeters(sample: Pick<PlanetSurfaceSample, 'ocean' | 'heightMeters'>): number {
  return sample.ocean ? 0 : sample.heightMeters;
}

function weatherHash(seed: number, x: number, y: number, channel: number): number {
  return hashUnit(
    seed ^ Math.imul(x, 0x45d9f3b) ^ Math.imul(y, 0x119de1f3) ^ Math.imul(channel, 0x27d4eb2d),
  );
}

function createCumulusGeometry(sculpted = false): THREE.BufferGeometry {
  // Legacy captures intentionally retain their exact three 20-triangle
  // diamonds. Shared real-weather formations use four connected, gently
  // rounded 80-triangle lobes: still one instanced geometry and two draws,
  // but no giant translucent crystal faces across the mountain horizon.
  const facet = new THREE.IcosahedronGeometry(1, sculpted ? 1 : 0);
  const sourcePositions = facet.getAttribute('position');
  const sourceNormals = facet.getAttribute('normal');
  const lobes = sculpted
    ? [
      { offset: [0, 0.045, 0], scale: [0.53, 0.67, 0.61] },
      { offset: [-0.38, -0.12, 0.055], scale: [0.4, 0.48, 0.48] },
      { offset: [0.37, -0.135, -0.055], scale: [0.38, 0.455, 0.46] },
      { offset: [0.055, 0.345, -0.015], scale: [0.32, 0.375, 0.365] },
    ] as const
    : [
      { offset: [0, 0.055, 0], scale: [0.62, 0.77, 0.72] },
      { offset: [-0.45, -0.115, 0.07], scale: [0.46, 0.54, 0.57] },
      { offset: [0.47, -0.145, -0.065], scale: [0.4, 0.47, 0.5] },
    ] as const;
  const positions = new Float32Array(sourcePositions.count * lobes.length * 3);
  const normals = new Float32Array(positions.length);
  const normal = new THREE.Vector3();

  for (let lobe = 0; lobe < lobes.length; lobe += 1) {
    const { offset, scale } = lobes[lobe]!;
    for (let vertex = 0; vertex < sourcePositions.count; vertex += 1) {
      const destination = (lobe * sourcePositions.count + vertex) * 3;
      positions[destination] = sourcePositions.getX(vertex) * scale[0] + offset[0];
      positions[destination + 1] = sourcePositions.getY(vertex) * scale[1] + offset[1];
      positions[destination + 2] = sourcePositions.getZ(vertex) * scale[2] + offset[2];
      normal.set(
        sourceNormals.getX(vertex) / scale[0],
        sourceNormals.getY(vertex) / scale[1],
        sourceNormals.getZ(vertex) / scale[2],
      ).normalize();
      normals[destination] = normal.x;
      normals[destination + 1] = normal.y;
      normals[destination + 2] = normal.z;
    }
  }

  facet.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  geometry.userData.lobeCount = lobes.length;
  geometry.userData.triangleCount = positions.length / 9;
  geometry.userData.sculptedCumulus = sculpted;
  return geometry;
}

function createWeatherMaterial(
  planet: PlanetDescriptor,
  lighting: AtmosphericWeatherLighting,
  layer: 'near' | 'far',
  residencyOpacity: THREE.InstancedBufferAttribute,
  options: AtmosphericWeatherOptions = {},
): AtmosphericWeatherMaterial {
  const celestial = lighting.celestial;
  const sharedStormVisuals = Boolean(options.weatherField?.supported);
  const cloudOpacityScale = options.weatherField?.cloudOpacityScale ?? planet.atmosphere.cloudOpacityScale;
  const uniforms = {
    primaryLightDirection: celestial?.directions[0] ?? uniform(lighting.primary),
    secondaryLightDirection: celestial?.directions[1] ?? uniform(lighting.secondary),
    tertiaryLightDirection: celestial?.directions[2] ?? uniform(new THREE.Vector3(0, 1, 0)),
    primaryStarColor: celestial?.colors[0] ?? uniform(lighting.primaryColor),
    secondaryStarColor: celestial?.colors[1] ?? uniform(lighting.secondaryColor),
    tertiaryStarColor: celestial?.colors[2] ?? uniform(new THREE.Color('#FFFFFF')),
    primaryTransmissionColor: celestial?.transmissionColors[0] ?? uniform(new THREE.Color('#FFFFFF')),
    secondaryTransmissionColor: celestial?.transmissionColors[1] ?? uniform(new THREE.Color('#FFFFFF')),
    tertiaryTransmissionColor: celestial?.transmissionColors[2] ?? uniform(new THREE.Color('#FFFFFF')),
    primaryIrradiance: celestial?.irradiance[0] ?? uniform(1),
    secondaryIrradiance: celestial?.irradiance[1] ?? uniform(lighting.secondaryStrength.value),
    tertiaryIrradiance: celestial?.irradiance[2] ?? uniform(0),
    primaryHorizonVisibility: celestial?.horizon[0] ?? uniform(1),
    secondaryHorizonVisibility: celestial?.horizon[1] ?? uniform(1),
    tertiaryHorizonVisibility: celestial?.horizon[2] ?? uniform(0),
    primaryTransmittance: celestial?.transmittance[0] ?? uniform(1),
    secondaryTransmittance: celestial?.transmittance[1] ?? uniform(1),
    tertiaryTransmittance: celestial?.transmittance[2] ?? uniform(0),
    primaryEclipseVisibility: celestial?.eclipse[0] ?? uniform(1),
    secondaryEclipseVisibility: celestial?.eclipse[1] ?? uniform(1),
    tertiaryEclipseVisibility: celestial?.eclipse[2] ?? uniform(0),
    celestialDaylight: celestial?.daylight ?? uniform(1),
    activeCelestialSources: celestial?.activeCount ?? uniform(2),
    secondaryStrength: uniform(lighting.secondaryStrength.value),
    horizonColor: uniform(new THREE.Color(planet.colors.atmosphere)),
    twilightColor: uniform(new THREE.Color(planet.colors.accent)),
    layerOpacity: uniform((sharedStormVisuals
      ? (layer === 'near' ? 0.3 : 0.2)
      : (layer === 'near' ? 0.16 : 0.095)) * cloudOpacityScale),
    presentationOpacity: uniform(0),
    observerDensity: uniform(0),
    cloudDensity: uniform(0),
    groundVisibility: uniform(1),
    weatherHumidity: uniform(0),
    opticalDepth: uniform(0),
    stormIntensity: uniform(0),
    weatherFieldDensity: uniform(0),
    windPhase: uniform(0),
    time: uniform(0),
  };

  // NodeMaterial owns instance matrices, instance colors, logarithmic depth,
  // and backend shader generation for both WebGPU and its WebGL2 fallback.
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    alphaTest: 0.0018,
  }) as AtmosphericWeatherMaterial;
  Object.defineProperty(material, 'uniforms', {
    value: uniforms,
    enumerable: true,
  });

  const normalDirection = normalWorldGeometry.normalize();
  const viewDirection = cameraPosition.sub(positionWorld).normalize();
  const facing = normalDirection.dot(viewDirection).abs();
  const center = smoothstep(0.07, 0.83, facing);
  const edge = float(1).sub(facing).max(0).pow(2.2);
  const softSilhouette = smoothstep(
    sharedStormVisuals ? 0.035 : 0.075,
    sharedStormVisuals ? 0.36 : 0.49,
    facing,
  );
  const primaryDirection = uniforms.primaryLightDirection.normalize();
  const secondaryDirection = uniforms.secondaryLightDirection.normalize();
  const tertiaryDirection = uniforms.tertiaryLightDirection.normalize();
  const loft = positionGeometry.y.mul(0.5).add(0.5).clamp(0, 1);
  const facet = loft.mul(5).floor().mul(0.062).add(0.72);

  // All three slots remain fixed TSL nodes. A star contributes only when its
  // actual receiver can see it above the true horizon, through the atmosphere,
  // and around any real intervening body.
  const primaryWeight = uniforms.primaryIrradiance.max(0).min(2.8)
    .mul(uniforms.primaryHorizonVisibility)
    .mul(uniforms.primaryTransmittance)
    .mul(uniforms.primaryEclipseVisibility);
  const secondaryWeight = uniforms.secondaryIrradiance.max(0).min(2.8)
    .mul(uniforms.secondaryHorizonVisibility)
    .mul(uniforms.secondaryTransmittance)
    .mul(uniforms.secondaryEclipseVisibility);
  const tertiaryWeight = uniforms.tertiaryIrradiance.max(0).min(2.8)
    .mul(uniforms.tertiaryHorizonVisibility)
    .mul(uniforms.tertiaryTransmittance)
    .mul(uniforms.tertiaryEclipseVisibility);
  const primary = normalDirection.dot(primaryDirection).max(0).mul(primaryWeight);
  const secondary = normalDirection.dot(secondaryDirection).max(0).mul(secondaryWeight);
  const tertiary = normalDirection.dot(tertiaryDirection).max(0).mul(tertiaryWeight);
  const forwardPrimary = viewDirection.negate().dot(primaryDirection).max(0).pow(7)
    .mul(primaryWeight);
  const forwardSecondary = viewDirection.negate().dot(secondaryDirection).max(0).pow(6)
    .mul(secondaryWeight);
  const forwardTertiary = viewDirection.negate().dot(tertiaryDirection).max(0).pow(6)
    .mul(tertiaryWeight);
  const sourceVisibility = primaryWeight.add(secondaryWeight).add(tertiaryWeight).min(2.4);
  const daylight = uniforms.celestialDaylight.clamp(0, 1);
  // The permanent geographic cells never move. Actual descriptor wind evolves
  // only their fine internal light and moisture, avoiding camera-relative pops.
  const windAdvection = uniforms.windPhase.mul(1.35);
  const weatherPulse = windAdvection.add(positionGeometry.x.mul(4.7))
    .add(positionGeometry.z.mul(2.3)).sin().mul(0.06).add(0.94);
  const wispyCoverage = positionGeometry.x.mul(8)
    .add(positionGeometry.z.mul(6))
    .sub(windAdvection.mul(0.74))
    .sin()
    .mul(sharedStormVisuals ? 0.12 : 0.17)
    .add(sharedStormVisuals ? 0.81 : 0.67);
  const stormRelief = uniforms.stormIntensity.mul(0.68)
    .add(uniforms.weatherFieldDensity.mul(0.31)).min(0.88);
  const silverlining = float(1).sub(facing).max(0).pow(4.1)
    .mul(forwardPrimary.mul(sharedStormVisuals ? 1.16 : 0.79)
      .add(forwardSecondary.mul(sharedStormVisuals ? 0.92 : 0.61))
      .add(forwardTertiary.mul(sharedStormVisuals ? 0.72 : 0.54)));
  const selfShadow = loft.mul(0.59).add(0.12)
    .add(center.mul(0.12))
    .mul(float(1).sub(uniforms.opticalDepth.mul(0.27)))
    .mul(float(1).sub(stormRelief.mul(float(1).sub(loft).mul(0.28))));
  const cloudLight = primary.mul(0.59)
    .add(secondary.mul(0.47))
    .add(tertiary.mul(0.42))
    .add(daylight.mul(loft.mul(0.14).add(0.042)))
    .mul(selfShadow)
    .add(0.012)
    .mul(facet);
  // Source weights already contain physical luminance transmission. Normalize
  // its spectral tint so the actual red/green/blue attenuation is applied once,
  // while achromatic cloud shading and opacity keep the same real extinction.
  const primaryTransmissionTint = uniforms.primaryTransmissionColor.rgb.div(
    uniforms.primaryTransmittance.max(0.0001),
  );
  const secondaryTransmissionTint = uniforms.secondaryTransmissionColor.rgb.div(
    uniforms.secondaryTransmittance.max(0.0001),
  );
  const tertiaryTransmissionTint = uniforms.tertiaryTransmissionColor.rgb.div(
    uniforms.tertiaryTransmittance.max(0.0001),
  );
  const primaryScatter = uniforms.primaryStarColor.rgb.mul(primaryTransmissionTint).mul(
    primary.mul(0.42).add(forwardPrimary.mul(0.37)).add(silverlining.mul(0.28)),
  );
  const secondaryScatter = uniforms.secondaryStarColor.rgb.mul(secondaryTransmissionTint).mul(
    secondary.mul(0.36).add(forwardSecondary.mul(0.31)),
  );
  const tertiaryScatter = uniforms.tertiaryStarColor.rgb.mul(tertiaryTransmissionTint).mul(
    tertiary.mul(0.32).add(forwardTertiary.mul(0.27)),
  );
  const atmosphereScatter = uniforms.horizonColor.mul(
    edge.mul(daylight).mul(0.09).add(loft.mul(daylight).mul(0.027)),
  );
  const twilightWindow = smoothstep(0.015, 0.24, daylight)
    .mul(float(1).sub(smoothstep(0.36, 0.86, daylight)));
  const twilightScatter = uniforms.twilightColor.mul(
    twilightWindow.mul(edge.mul(0.13).add(uniforms.weatherHumidity.mul(0.042))),
  );
  material.colorNode = vec3(cloudLight)
    .add(primaryScatter)
    .add(secondaryScatter)
    .add(tertiaryScatter)
    .add(atmosphereScatter)
    .add(twilightScatter)
    .add(uniforms.horizonColor.mul(silverlining).mul(stormRelief.mul(0.12).add(0.075)))
    .add(uniforms.primaryStarColor.rgb.mul(silverlining).mul(stormRelief).mul(0.085));
  const silhouetteCoverage = sharedStormVisuals
    ? center.mul(0.58).add(edge.mul(0.17)).add(0.13)
    : center.mul(0.43).add(edge.mul(0.1)).add(0.07);
  material.opacityNode = uniforms.layerOpacity
    .mul(silhouetteCoverage)
    .mul(weatherPulse)
    .mul(wispyCoverage)
    .mul(softSilhouette)
    .mul(uniforms.observerDensity.mul(sharedStormVisuals ? 0.18 : 0.26)
      .add(sharedStormVisuals ? 0.79 : 0.64))
    .mul(uniforms.opticalDepth.mul(0.12).add(0.91))
    .mul(stormRelief.mul(sharedStormVisuals ? 0.51 : 0.34).add(1))
    .mul(float(1).sub(uniforms.cloudDensity.mul(0.27)))
    .mul(daylight.mul(0.61).add(sourceVisibility.mul(0.32)).add(0.1).clamp(0.1, 1))
    .mul(uniforms.groundVisibility)
    .min(sharedStormVisuals ? (layer === 'near' ? 0.26 : 0.19) : 0.16)
    .mul(uniforms.presentationOpacity)
    .mul(instancedDynamicBufferAttribute<'float'>(residencyOpacity, 'float'));
  material.userData.weatherLayer = layer;
  material.userData.bodyId = planet.id;
  material.userData.cloudType = planet.atmosphere.cloudType;
  material.userData.cloudOpacityScale = cloudOpacityScale;
  material.userData.proceduralTslWeather = true;
  material.userData.physicalBinaryStarScattering = true;
  material.userData.physicalCelestialSourceSlots = 3;
  material.userData.horizonAwareStellarScattering = true;
  material.userData.actualEclipseVisibility = true;
  material.userData.spectralCloudSilverlining = true;
  material.userData.selfShadowedCloudUndersides = true;
  material.userData.coherentBodyFixedWind = true;
  material.userData.perInstanceResidencyFade = true;
  material.userData.sharedPlanetWeather = Boolean(options.weatherField);
  material.userData.sharedWeatherDensity = Boolean(options.weatherField);
  material.userData.actualStormCoverage = Boolean(options.weatherField);
  material.userData.readablePhysicalStormSilhouette = sharedStormVisuals;
  material.userData.sharedWeatherNodeBridge = Boolean(options.weatherNodes);
  if (options.weatherField) material.userData.weatherFieldBodyId = options.weatherField.bodyId;
  if (celestial) {
    material.userData.celestialLighting = celestial;
    material.userData.celestialSourceIds = celestial.sourceIds;
  }
  return material;
}

/**
 * Bounded cloud geometry in the actual rotating body's frame, never in camera
 * space. Only the selected quantized geographic neighborhood is instantiated.
 */
export class AtmosphericWeather {
  readonly group = new THREE.Group();
  readonly state: PlanetWeatherState;
  /** Actual body-relative angular advection derived from the simulated wind. */
  readonly windAngularVelocityRadiansPerSecond: number;

  private readonly planet: PlanetDescriptor;
  private readonly field: PlanetField;
  private readonly lighting: AtmosphericWeatherLighting;
  private readonly weatherField?: PlanetWeatherField;
  private readonly cloudOpacityScale: number;
  private readonly renderRadius: number;
  private readonly metersToRender: number;
  private readonly near?: THREE.InstancedMesh<THREE.BufferGeometry, AtmosphericWeatherMaterial>;
  private readonly far?: THREE.InstancedMesh<THREE.BufferGeometry, AtmosphericWeatherMaterial>;
  private readonly nearResidency?: CloudRegionResidency<WeatherFormation>;
  private readonly farResidency?: CloudRegionResidency<WeatherFormation>;
  private readonly nearOpacity?: THREE.InstancedBufferAttribute;
  private readonly farOpacity?: THREE.InstancedBufferAttribute;
  private readonly anchors: WeatherClusterAnchor[] = [];
  private readonly observerDirection = new THREE.Vector3(0, 1, 0);
  private readonly direction = new THREE.Vector3();
  private readonly transform = new THREE.Object3D();
  private readonly zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  private observerTerrainHeightMeters = 0;
  private currentWeatherSample?: PlanetWeatherSample;

  constructor(
    planet: PlanetDescriptor,
    field: PlanetField,
    renderRadius: number,
    lighting: AtmosphericWeatherLighting,
    options: AtmosphericWeatherOptions = {},
  ) {
    this.planet = planet;
    this.field = field;
    this.lighting = lighting;
    this.weatherField = options.weatherField;
    this.renderRadius = renderRadius;
    this.metersToRender = renderRadius / planet.radiusMeters;
    const hasAtmosphere = hasRenderableAtmosphere(planet.atmosphere);
    const supported = supportsAtmosphericClouds(planet.atmosphere) &&
      (options.weatherField?.supported ?? true);
    this.cloudOpacityScale = supported
      ? options.weatherField?.cloudOpacityScale ?? planet.atmosphere.cloudOpacityScale
      : 0;
    const base = supported
      ? options.weatherField?.cloudBaseMeters ?? planet.atmosphere.cloudBaseMeters
      : 0;
    const top = supported
      ? options.weatherField?.cloudTopMeters ?? planet.atmosphere.cloudTopMeters
      : 0;
    this.state = {
      hasAtmosphere,
      supported,
      bodyId: planet.id,
      atmosphericDensity: 0,
      cloudDensity: 0,
      insideCloud: false,
      cloudBaseMeters: base,
      cloudTopMeters: top,
      observerAltitudeMeters: Number.POSITIVE_INFINITY,
      localMoisture: 0,
      cloudCoverage: 0,
      cellKey: '',
      localClusterCount: 0,
      nearClusterCount: 0,
      farClusterCount: 0,
      rareFormationCount: 0,
      precipitation: 0,
      surfaceClearanceMeters: Number.POSITIVE_INFINITY,
      opticalDepth: 0,
      weatherPhase: 0,
      stormIntensity: 0,
      weatherFieldDensity: 0,
      weatherEpochSeconds: 0,
      windSpeedMetersPerSecond: hasAtmosphere
        ? options.weatherField?.windSpeedMetersPerSecond ??
          Math.min(38, 4 + Math.PI * 2 * planet.radiusMeters / planet.rotationPeriodSeconds * 0.095)
        : 0,
    };
    this.windAngularVelocityRadiansPerSecond = options.weatherField?.windAngularVelocityRadiansPerSecond ??
      this.state.windSpeedMetersPerSecond / Math.max(1, planet.radiusMeters);
    this.group.name = 'body-fixed-local-weather';
    this.group.visible = false;
    this.group.userData = {
      bodyId: planet.id,
      atmosphereRegime: planet.atmosphere.regime,
      hasAtmosphere,
      cloudType: supported ? planet.atmosphere.cloudType : 'none',
      cloudOpacityScale: this.cloudOpacityScale,
      bodyFixed: true,
      quantizedCellMeters: WEATHER_CELL_METERS,
      cloudBaseMeters: base,
      cloudTopMeters: top,
      cellKey: '',
      clusters: this.anchors,
      physicallyAnchored: true,
      volumetricStyle: true,
      boundedInstancedDraws: supported ? 2 : 0,
      rareFormationCount: 0,
      weatherPhase: 0,
      anchoredWindEvolution: true,
      physicalCelestialSourceSlots: 3,
      horizonAwareStellarScattering: true,
      actualEclipseVisibility: true,
      physicalWindAngularVelocityRadiansPerSecond: this.windAngularVelocityRadiansPerSecond,
      farWeatherCellMeters: supported ? WEATHER_CELL_METERS * FAR_WEATHER_CELL_STRIDE : 0,
      farWeatherRadiusMeters: supported ? FAR_WEATHER_RADIUS_METERS : 0,
      sharedPlanetWeather: Boolean(options.weatherField),
      sharedWeatherNodeBridge: Boolean(options.weatherNodes),
      weatherFieldBodyId: options.weatherField?.bodyId,
      weatherFieldSeed: options.weatherField?.seed,
      stormIntensity: 0,
      weatherFieldDensity: 0,
      stablePhysicalCellGrid: true,
      wrappedLongitudeCells: true,
      perInstanceResidencyFade: true,
      residencyFadeSeconds: CLOUD_RESIDENCY_LIMITS.fadeSeconds,
      residencyCacheLimitPerLayer: CLOUD_RESIDENCY_LIMITS.cachedCellsPerLayer,
      incrementalCellEvaluationsPerUpdate: CLOUD_RESIDENCY_LIMITS.newCellsPerLayerUpdate * 2,
      localPresentationOpacity: 0,
    };
    if (lighting.celestial) {
      this.group.userData.celestialLighting = lighting.celestial;
      this.group.userData.celestialSourceIds = lighting.celestial.sourceIds;
    }
    if (!supported) return;

    const geometry = createCumulusGeometry(Boolean(options.weatherField?.supported));
    this.nearOpacity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NEAR_CLUSTERS), 1)
      .setUsage(THREE.DynamicDrawUsage);
    this.farOpacity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FAR_CLUSTERS), 1)
      .setUsage(THREE.DynamicDrawUsage);
    this.near = new THREE.InstancedMesh(
      geometry,
      createWeatherMaterial(planet, lighting, 'near', this.nearOpacity, options),
      MAX_NEAR_CLUSTERS,
    );
    // Three r185 declares instanceColor only when the mesh already owns the
    // attribute. Frozen mountain cells can legitimately contain zero banks;
    // their custom shader must still compile during a real system switch.
    this.near.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_NEAR_CLUSTERS * 3).fill(1),
      3,
    );
    this.near.name = 'body-fixed-near-cloud-clusters';
    this.near.count = 0;
    this.near.frustumCulled = false;
    this.near.renderOrder = 7;
    this.near.userData.bodyId = planet.id;
    this.near.userData.bodyFixed = true;
    this.near.userData.residencyOpacity = this.nearOpacity;
    this.near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.far = new THREE.InstancedMesh(
      geometry,
      createWeatherMaterial(planet, lighting, 'far', this.farOpacity, options),
      MAX_FAR_CLUSTERS,
    );
    this.far.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_FAR_CLUSTERS * 3).fill(1),
      3,
    );
    this.far.name = 'body-fixed-far-cloud-wisps';
    this.far.count = 0;
    this.far.frustumCulled = false;
    this.far.renderOrder = 6;
    this.far.userData.bodyId = planet.id;
    this.far.userData.bodyFixed = true;
    this.far.userData.residencyOpacity = this.farOpacity;
    this.far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.far, this.near);
    this.nearResidency = this.createResidency('near', this.near, this.nearOpacity);
    this.farResidency = this.createResidency('far', this.far, this.farOpacity);
    this.near.userData.residency = this.nearResidency;
    this.far.userData.residency = this.farResidency;
    this.group.userData.residency = {
      near: this.nearResidency.stats,
      far: this.farResidency.stats,
    };
  }

  setObserver(bodyFixedDirection: THREE.Vector3, altitudeMeters: number, elapsedSeconds = 0): PlanetWeatherState {
    if (bodyFixedDirection.lengthSq() === 0) return this.state;
    this.observerDirection.copy(bodyFixedDirection).normalize();
    this.state.observerAltitudeMeters = Number.isFinite(altitudeMeters)
      ? altitudeMeters : Number.POSITIVE_INFINITY;
    // Air density is meaningful on clear worlds too. Exospheres take the
    // cheap no-weather path without sampling terrain or allocating an atlas.
    this.state.atmosphericDensity = sampleAtmosphereDensity(
      this.planet.atmosphere, this.state.observerAltitudeMeters,
    );
    if (!this.state.hasAtmosphere) {
      this.update(elapsedSeconds);
      return this.state;
    }
    const sample = weatherSample(this.field, this.observerDirection);
    this.observerTerrainHeightMeters = weatherSurfaceHeightMeters(sample);
    this.state.surfaceClearanceMeters = Math.max(
      0,
      this.state.observerAltitudeMeters - this.observerTerrainHeightMeters,
    );
    if (!this.state.supported) {
      this.state.localMoisture = THREE.MathUtils.clamp(sample.weatherHumidity ?? sample.moisture, 0, 1);
      this.update(elapsedSeconds);
      return this.state;
    }
    this.currentWeatherSample = this.weatherField?.sample(this.observerDirection, elapsedSeconds);
    this.state.localMoisture = THREE.MathUtils.clamp(
      this.currentWeatherSample?.humidity ?? sample.weatherHumidity ?? sample.moisture,
      0,
      1,
    );
    this.state.cloudCoverage = THREE.MathUtils.clamp(
      this.currentWeatherSample?.coverage ?? sample.cloudCoverage ?? this.planet.atmosphere.cloudCoverage,
      0,
      1,
    );
    this.state.stormIntensity = this.currentWeatherSample?.stormIntensity ?? 0;
    this.state.weatherFieldDensity = this.currentWeatherSample?.density ?? 0;
    this.state.weatherEpochSeconds = elapsedSeconds;

    this.update(elapsedSeconds);
    return this.state;
  }

  update(elapsedSeconds: number): void {
    // Orbital clouds drift at the actual wind speed, not the body's rotation.
    // Cancel that parent advection so local geographic cells stay body-fixed.
    // The authoritative field moves -Y; legacy callers retain their original
    // +Y convention while the shared field and its TSL bridge agree exactly.
    this.group.rotation.y = elapsedSeconds * this.windAngularVelocityRadiansPerSecond *
      (this.weatherField ? 1 : -1);
    if (!this.state.supported) {
      this.state.weatherEpochSeconds = elapsedSeconds;
      this.state.weatherPhase = elapsedSeconds * this.state.windSpeedMetersPerSecond / WEATHER_CELL_METERS;
      this.updateDensity();
      this.group.userData.weatherEpochSeconds = elapsedSeconds;
      this.group.userData.weatherPhase = this.state.weatherPhase;
      this.group.userData.localPresentationOpacity = 0;
      this.group.visible = false;
      return;
    }
    if (
      this.weatherField &&
      Number.isFinite(this.state.observerAltitudeMeters) &&
      elapsedSeconds !== this.state.weatherEpochSeconds
    ) {
      this.currentWeatherSample = this.weatherField.sample(this.observerDirection, elapsedSeconds);
      this.state.localMoisture = this.currentWeatherSample.humidity;
      this.state.cloudCoverage = this.currentWeatherSample.coverage;
      this.state.stormIntensity = this.currentWeatherSample.stormIntensity;
      this.state.weatherFieldDensity = this.currentWeatherSample.density;
      this.state.weatherEpochSeconds = elapsedSeconds;
    }
    this.updateResidency(elapsedSeconds);
    this.updateDensity();
    const presentationOpacity = (1 - THREE.MathUtils.smoothstep(
      Math.max(0, this.state.observerAltitudeMeters),
      this.planet.atmosphere.heightMeters * LOCAL_CLOUD_FADE_START_ATMOSPHERE,
      this.planet.atmosphere.heightMeters * LOCAL_CLOUD_FADE_END_ATMOSPHERE,
    )) * THREE.MathUtils.smoothstep(this.state.cloudCoverage, 0.005, 0.055);
    this.group.userData.localPresentationOpacity = presentationOpacity;
    this.group.visible = this.state.supported && presentationOpacity > 0.000_01 &&
      this.state.localClusterCount > 0;
    const surfaceClearance = this.state.surfaceClearanceMeters;
    this.state.weatherPhase = elapsedSeconds * this.state.windSpeedMetersPerSecond /
      WEATHER_CELL_METERS;
    this.group.userData.weatherPhase = this.state.weatherPhase;
    this.group.userData.stormIntensity = this.state.stormIntensity;
    this.group.userData.weatherFieldDensity = this.state.weatherFieldDensity;
    this.group.userData.weatherEpochSeconds = elapsedSeconds;
    const clearOfGround = THREE.MathUtils.smoothstep(surfaceClearance, 180, 1_150);
    for (const layer of [this.near, this.far]) {
      if (!layer) continue;
      layer.material.uniforms.time!.value = elapsedSeconds;
      layer.material.uniforms.presentationOpacity!.value = presentationOpacity;
      layer.material.uniforms.observerDensity!.value = this.state.atmosphericDensity;
      layer.material.uniforms.cloudDensity!.value = this.state.cloudDensity;
      layer.material.uniforms.weatherHumidity!.value = this.state.localMoisture;
      layer.material.uniforms.opticalDepth!.value = this.state.opticalDepth;
      layer.material.uniforms.stormIntensity!.value = this.state.stormIntensity;
      layer.material.uniforms.weatherFieldDensity!.value = this.state.weatherFieldDensity;
      layer.material.uniforms.windPhase!.value = this.state.weatherPhase;
      layer.material.uniforms.secondaryStrength!.value = this.lighting.secondaryStrength.value;
      if (!this.lighting.celestial) {
        layer.material.uniforms.secondaryIrradiance!.value = this.lighting.secondaryStrength.value;
      }
      // Clouds remain physically present and traversable. Only their additive
      // presentation recedes near the real sampled ground, where kilometer-wide
      // overhead lobes would otherwise overwhelm the surface composition.
      const lowAltitudeVisibility = this.weatherField
        ? (layer === this.near ? 0.12 : 0.34)
        : (layer === this.near ? 0.08 : 0.18);
      layer.material.uniforms.groundVisibility!.value = Math.max(
        THREE.MathUtils.lerp(lowAltitudeVisibility, 1, clearOfGround),
        this.state.insideCloud ? 0.84 : 0,
      );
    }
  }

  private createResidency(
    layer: CloudResidencyLayer,
    mesh: THREE.InstancedMesh<THREE.BufferGeometry, AtmosphericWeatherMaterial>,
    opacity: THREE.InstancedBufferAttribute,
  ): CloudRegionResidency<WeatherFormation> {
    return new CloudRegionResidency({
      grid: createCloudCellGrid(this.planet.id, this.planet.radiusMeters, layer),
      resolve: (cell) => this.createFormation(cell),
      assign: (slot, formation) => {
        mesh.setMatrixAt(slot, formation.matrix);
        mesh.setColorAt(slot, formation.color);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      },
      release: (slot) => {
        mesh.setMatrixAt(slot, this.zeroMatrix);
        mesh.instanceMatrix.needsUpdate = true;
      },
      opacity: (slot, value) => {
        if (opacity.getX(slot) === value) return;
        opacity.setX(slot, value);
        opacity.needsUpdate = true;
      },
    });
  }

  private updateResidency(elapsedSeconds: number): void {
    if (!this.near || !this.far || !this.nearResidency || !this.farResidency ||
        !Number.isFinite(this.state.observerAltitudeMeters)) return;
    const prewarm = this.state.observerAltitudeMeters <
      this.planet.atmosphere.heightMeters * LOCAL_CLOUD_PREWARM_ATMOSPHERE;
    const nearChanged = this.nearResidency.update(this.observerDirection, elapsedSeconds, prewarm);
    const farChanged = this.farResidency.update(this.observerDirection, elapsedSeconds, prewarm);
    this.near.count = this.nearResidency.stats.submittedSlots;
    this.far.count = this.farResidency.stats.submittedSlots;
    if (nearChanged || farChanged) {
      this.anchors.length = 0;
      for (const residency of [this.farResidency, this.nearResidency]) {
        for (const resident of residency.slots) if (resident) this.anchors.push(resident.formation.anchor);
      }
      this.state.nearClusterCount = this.nearResidency.stats.residentCount;
      this.state.farClusterCount = this.farResidency.stats.residentCount;
      this.state.localClusterCount = this.anchors.length;
      this.state.rareFormationCount = this.anchors.filter((anchor) => anchor.formation !== 'bank').length;
      this.group.userData.rareFormationCount = this.state.rareFormationCount;
    }
    this.state.cellKey = this.nearResidency.regionKey;
    this.group.userData.cellKey = this.state.cellKey;
    this.group.userData.farCellKey = this.farResidency.regionKey;
  }

  private createFormation(cell: CloudCell): WeatherFormation | null {
    const layer = cell.layer;
    // Independent, globally wrapped physical lattices retain one exact
    // ID and transform even at the longitude seam and around a pole.
    const seed = this.planet.seed ^ (layer === 'far' ? 0x57f1a23b : 0);
    const seedX = cell.column;
    const seedY = cell.row;
    const occurrence = weatherHash(seed, seedX, seedY, 0);
    const anchorLatitude = cell.latitudeRadians +
      (weatherHash(seed, seedX, seedY, 2) - 0.5) * cell.latitudeStepRadians * 0.34;
    const anchorLongitude = cell.longitudeRadians +
      (weatherHash(seed, seedX, seedY, 1) - 0.5) * cell.longitudeStepRadians * 0.34;
    this.direction.set(
      Math.cos(anchorLatitude) * Math.cos(anchorLongitude),
      Math.sin(anchorLatitude),
      Math.cos(anchorLatitude) * Math.sin(anchorLongitude),
    ).normalize();
    // Formation identities belong to stable body geography. Evaluate the
    // shared climate at its canonical epoch; live storm advection then
    // changes shading and density without respawning visible cells.
    const climate = this.weatherField?.sample(this.direction, 0);
    let sample = climate ? undefined : weatherSample(this.field, this.direction);
    const humidity = THREE.MathUtils.clamp(
      climate?.humidity ?? sample?.weatherHumidity ?? sample?.moisture ?? 0,
      0,
      1,
    );
    const localCoverage = THREE.MathUtils.clamp(
      climate?.coverage ?? sample?.cloudCoverage ?? this.planet.atmosphere.cloudCoverage,
      0,
      1,
    );
    const storm = climate?.stormIntensity ?? 0;
    // A cell's existence belongs to its permanent geography, not to the
    // moving observer neighborhood. Sparse near-field weather avoids a
    // 49-bank ceiling while shared cells persist unchanged across travel.
    const baselineOccurrence = layer === 'near'
      ? Math.min(0.76, 0.16 + localCoverage * 0.44 + humidity * 0.23)
      : Math.min(0.92, 0.12 + localCoverage * 0.83 + humidity * 0.31);
    const occurrenceLimit = (climate
      ? Math.min(layer === 'near' ? 0.86 : 0.96,
        baselineOccurrence + storm * 0.14 + climate.orographicLift * 0.07)
      : baselineOccurrence) * this.cloudOpacityScale;
    if (occurrence > occurrenceLimit) return null;
    sample ??= weatherSample(this.field, this.direction);
    const thickness = this.state.cloudTopMeters - this.state.cloudBaseMeters;
    const preferredAltitude = this.state.cloudBaseMeters + thickness * (
      layer === 'near'
        ? 0.13 + weatherHash(seed, seedX, seedY, 3) * 0.48
        : 0.47 + weatherHash(seed, seedX, seedY, 3) * 0.37
    );
    const rarity = weatherHash(seed, seedX, seedY, 8);
    const towerThreshold = climate ? 0.095 + storm * 0.16 : 0.095;
    const anvilThreshold = climate ? 0.895 - storm * 0.17 : 0.895;
    const formation: WeatherClusterAnchor['formation'] = rarity < towerThreshold
      ? 'tower'
      : rarity > anvilThreshold && humidity > 0.3
        ? 'anvil'
        : 'bank';
    const ordinaryWidth = (layer === 'near' ? 680 : 480) +
      weatherHash(seed, seedX, seedY, 4) * (layer === 'near' ? 240 : 420);
    const width = Math.min(
      920,
      ordinaryWidth * (formation === 'tower'
        ? (climate ? 0.78 : 0.84)
        : formation === 'anvil'
          ? (climate ? 1.12 : 1.055)
          : 1),
    );
    const depth = width * (
      (layer === 'near' ? 0.78 : 0.62) +
      weatherHash(seed, seedX, seedY, 5) * (layer === 'near' ? 0.18 : 0.31)
    );
    const ordinaryHeight = (layer === 'near' ? 200 : 150) +
      weatherHash(seed, seedX, seedY, 6) * (layer === 'near' ? 360 : 260);
    const appearance = planetCloudAppearance(this.planet.atmosphere.cloudType);
    const preferredHeight = ordinaryHeight * appearance.verticalScale *
      (formation === 'tower'
        ? (climate ? 1.36 + storm * 0.48 : 1.23)
        : formation === 'anvil'
          ? (climate ? 0.61 : 0.73)
          : 1);
    const terrainHeight = weatherSurfaceHeightMeters(sample);
    // A global pressure band cannot override the actual local heightfield:
    // even the deterministic central bank must clear mountains physically.
    const availableBottom = Math.max(this.state.cloudBaseMeters,
      terrainHeight + PLANET_CLOUD_TERRAIN_CLEARANCE_METERS);
    const availableThickness = this.state.cloudTopMeters - availableBottom;
    if (availableThickness < 320) return null;
    const height = Math.min(preferredHeight, availableThickness * 0.46);
    const altitude = THREE.MathUtils.clamp(
      preferredAltitude,
      availableBottom + height,
      this.state.cloudTopMeters - height,
    );
    const density = THREE.MathUtils.clamp(
      0.38 + humidity * 0.43 + occurrence * 0.14 + storm * 0.15,
      0.18,
      0.96,
    ) * this.cloudOpacityScale;
    this.transform.position.copy(this.direction).multiplyScalar(
      this.renderRadius + altitude * this.metersToRender,
    );
    this.transform.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.direction);
    this.transform.rotateY(weatherHash(seed, seedX, seedY, 7) * Math.PI);
    this.transform.scale.set(
      width * this.metersToRender,
      height * this.metersToRender,
      depth * this.metersToRender,
    );
    this.transform.updateMatrix();
    const color = new THREE.Color(layer === 'near' ? '#A58AD9' : '#7869BB')
      .lerp(new THREE.Color('#CD80CE'), humidity * 0.22)
      .lerp(new THREE.Color(this.planet.colors.atmosphere), layer === 'far' ? 0.19 : 0.11)
      .lerp(new THREE.Color(formation === 'tower' ? '#77E9F1' : '#EE9EDF'),
        formation === 'bank' ? 0 : formation === 'tower' ? 0.15 + storm * 0.1 : 0.1 + storm * 0.07)
      .lerp(new THREE.Color(appearance.tint), appearance.tintStrength);
    const anchor: WeatherClusterAnchor = {
      id: cell.id,
      direction: { x: this.direction.x, y: this.direction.y, z: this.direction.z },
      altitudeMeters: altitude,
      terrainHeightMeters: terrainHeight,
      horizontalRadiusMeters: Math.min(width, depth),
      verticalRadiusMeters: height,
      humidity,
      density,
      layer,
      formation,
    };
    if (climate) {
      anchor.stormIntensity = storm;
      anchor.weatherFieldDensity = climate.density;
    }
    return { id: cell.id, direction: anchor.direction, anchor,
      matrix: this.transform.matrix.clone(), color };
  }

  private updateDensity(): void {
    let density = 0;
    if (this.state.supported) {
      for (const anchor of this.anchors) {
        this.direction.set(anchor.direction.x, anchor.direction.y, anchor.direction.z);
        const horizontalMeters = this.direction.angleTo(this.observerDirection) * this.planet.radiusMeters;
        const horizontal = horizontalMeters / anchor.horizontalRadiusMeters;
        const vertical = (this.state.observerAltitudeMeters - anchor.altitudeMeters) / anchor.verticalRadiusMeters;
        const squared = horizontal * horizontal + vertical * vertical;
        if (squared < 1) density += (1 - squared) * anchor.density * 0.78;
      }
    }
    if (this.currentWeatherSample) {
      density *= THREE.MathUtils.clamp(
        0.5 + this.currentWeatherSample.density * 0.62 + this.currentWeatherSample.stormIntensity * 0.22,
        0.38,
        1.18,
      );
    }
    this.state.cloudDensity = THREE.MathUtils.clamp(density, 0, 1);
    this.state.insideCloud = this.state.cloudDensity > 0.08;
    const localPrecipitation = (this.state.localMoisture - 0.68) * this.state.cloudCoverage *
      (this.state.insideCloud ? 2.7 : 0.5);
    this.state.precipitation = THREE.MathUtils.clamp(
      this.currentWeatherSample
        ? Math.max(localPrecipitation,
          this.currentWeatherSample.precipitation * (this.state.insideCloud ? 0.86 : 0.34))
        : localPrecipitation,
      0,
      1,
    );
    this.state.opticalDepth = THREE.MathUtils.clamp(
      this.state.atmosphericDensity *
        (0.47 + this.state.localMoisture * 0.22 + this.state.cloudDensity * 0.44),
      0,
      1,
    );
  }
}
