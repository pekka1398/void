import type { Material, Side } from 'three';
import {
  attribute,
  cameraPosition,
  cameraFar,
  cameraNear,
  float,
  Fn,
  materialEmissive,
  modelWorldMatrix,
  normalWorldGeometry,
  positionWorld,
  positionView,
  reflect,
  select,
  vec3,
  vec4,
  viewZToLogarithmicDepth,
} from 'three/tsl';
import { MeshLambertNodeMaterial, type Node } from 'three/webgpu';

import type { PlanetField, Rgb } from '../../fields/PlanetField';
import type { Vec3Like } from '../../fields/noise';
import type { CelestialLightSource } from '../../lighting';
import { useNodeAwareMaterialCacheKey } from '../../terrain/ContactRenderMask';
import {
  createSurfaceTerrainPalette,
  PLANET_APPEARANCE_POLICY,
} from '../../terrain/SurfaceTerrainPresentation';
import {
  applyPlanetWeatherToLambertMaterial,
  type PlanetWeatherNodes,
} from './PlanetWeatherNodes';
import { planetMeanSeaLogDepth, type PlanetOceanDepthNodes } from './PlanetOceanDepth';

export interface PlanetLandMaterialOptions {
  /** Actual body-fixed position, including the tile/patch origin, in meters. */
  readonly bodyPositionMeters: Node<'vec3'>;
  readonly metersPerRenderUnit: number;
  readonly weatherNodes?: PlanetWeatherNodes;
  readonly bodyUpWorld?: Node<'vec3'>;
  readonly haze?: boolean;
  /** Cheap real-star water response for wet streamed tiles, never the globe overlay. */
  readonly orbitalWater?: boolean;
  /** This geometry fuses mean-sea water and land, unlike physical seabed/contact meshes. */
  readonly fusedOceanDepth?: boolean;
  readonly oceanDepth?: PlanetOceanDepthNodes;
  /** Existing ring/albedo multiplier; vertex colors are multiplied exactly once. */
  readonly colorNode?: MeshLambertNodeMaterial['colorNode'];
  readonly maskNode?: MeshLambertNodeMaterial['maskNode'];
  readonly depthNode?: MeshLambertNodeMaterial['depthNode'];
  readonly side?: Side;
  readonly flatShading?: boolean;
}

/** Match the orbital overlay's source range/lobe without introducing a new ocean palette. */
export const PLANET_ORBITAL_WATER = Object.freeze({
  depthScaleMeters: 1_650,
  wetStart: 0.17,
  wetFull: 0.72,
  facetStart: 0.55,
  facetFull: 0.82,
  solarHorizonFull: 0.08,
  maximumSourceIrradiance: 3.2,
  specularPower: 24,
  specularGain: 0.14,
  fresnelGain: 0.1,
  scatterGain: 0.03,
  depthAbsorption: 0.42,
  maximumLinearContribution: 0.24,
} as const);

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function smoothUnit(low: number, high: number, value: number): number {
  const fraction = clampUnit((value - low) / (high - low));
  return fraction * fraction * (3 - 2 * fraction);
}

function unitDirection(value: Vec3Like): Vec3Like | undefined {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length <= Number.EPSILON) return undefined;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function dotDirection(first: Vec3Like, second: Vec3Like): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

/** Vertical, render-only skirt walls cannot inherit water from their wet top edge. */
export function planetOrbitalWaterEligibility(wetness: number, facetDotRadial: number): number {
  return smoothUnit(PLANET_ORBITAL_WATER.wetStart, PLANET_ORBITAL_WATER.wetFull, clampUnit(wetness)) *
    smoothUnit(PLANET_ORBITAL_WATER.facetStart, PLANET_ORBITAL_WATER.facetFull, Math.abs(facetDotRadial));
}

export interface PlanetOrbitalWaterSample {
  readonly waterColor: Rgb;
  readonly wetness: number;
  /** Same normalized depth attribute as the shared globe: actual meters / 1650. */
  readonly waterDepth: number;
  readonly radialDirectionWorld: Vec3Like;
  readonly facetNormalWorld: Vec3Like;
  readonly viewDirectionWorld: Vec3Like;
  readonly sources: readonly CelestialLightSource[];
  readonly cloudTransmission?: readonly number[];
}

/** CPU mirror of the small real-source term; useful for physical/calibration regressions. */
export function samplePlanetOrbitalWaterReflection(input: PlanetOrbitalWaterSample): Rgb {
  const policy = PLANET_ORBITAL_WATER;
  const radial = unitDirection(input.radialDirectionWorld);
  const facet = unitDirection(input.facetNormalWorld);
  const view = unitDirection(input.viewDirectionWorld);
  if (!radial || !facet || !view) return [0, 0, 0];
  const eligibility = planetOrbitalWaterEligibility(input.wetness, dotDirection(facet, radial));
  if (eligibility <= 0) return [0, 0, 0];
  const depthGain = 1 - clampUnit(input.waterDepth) * policy.depthAbsorption;
  const fresnel = 0.02 + 0.98 * (1 - clampUnit(dotDirection(radial, view))) ** 5;
  const output: [number, number, number] = [0, 0, 0];
  for (const source of input.sources.slice(0, 3)) {
    if (!source.active || !source.id) continue;
    const light = unitDirection(source.directionWorld);
    if (!light) continue;
    const solarCosine = Math.max(0, dotDirection(radial, light));
    const energy = Math.max(0, Math.min(policy.maximumSourceIrradiance,
      Number.isFinite(source.irradianceSolar) ? source.irradianceSolar : 0)) *
      clampUnit(source.horizonVisibility) * clampUnit(source.eclipseVisibility) *
      clampUnit(input.cloudTransmission?.[source.slot] ?? 1);
    if (energy <= 0 || solarCosine <= 0) continue;
    const reflected = { x: 2 * solarCosine * radial.x - light.x,
      y: 2 * solarCosine * radial.y - light.y, z: 2 * solarCosine * radial.z - light.z };
    const lobe = clampUnit(dotDirection(reflected, view)) ** policy.specularPower *
      (policy.specularGain + fresnel * policy.fresnelGain) *
      smoothUnit(0, policy.solarHorizonFull, solarCosine);
    const spectral = [source.spectralColor.r, source.spectralColor.g, source.spectralColor.b] as const;
    const transmission = [source.atmosphericTransmittance.r,
      source.atmosphericTransmittance.g, source.atmosphericTransmittance.b] as const;
    for (let channel = 0; channel < 3; channel += 1) {
      output[channel]! += clampUnit(spectral[channel]!) * clampUnit(transmission[channel]!) * energy *
        (clampUnit(input.waterColor[channel]!) * solarCosine * policy.scatterGain + lobe) * depthGain;
    }
  }
  return output.map((channel) => Math.min(policy.maximumLinearContribution, channel) * eligibility) as [number, number, number];
}

type WeatherAwarePlanetMaterial = MeshLambertNodeMaterial & {
  /** Supported by r185 setupLighting, but not declared on Lambert materials. */
  emissiveNode?: Node<'vec3'> | null;
  planetWeatherTransmissionNode?: Node<'vec3'>;
  planetOrbitalWaterReflectionNode?: Node<'vec3'>;
  planetMeanSeaDepthNode?: Node<'float'>;
};

/** Only genuinely wet, upward facets share the physical sea-depth datum. */
function addFusedOceanDepth(material: WeatherAwarePlanetMaterial, field: PlanetField,
  options: PlanetLandMaterialOptions): void {
  const actualDepth = material.depthNode ?? viewZToLogarithmicDepth(positionView.z, cameraNear, cameraFar);
  const seaDepth = planetMeanSeaLogDepth(field.radius / options.metersPerRenderUnit,
    options.bodyPositionMeters.div(options.metersPerRenderUnit), options.oceanDepth);
  const radial = options.bodyUpWorld ?? modelWorldMatrix
    .mul(vec4(options.bodyPositionMeters.normalize(), 0)).xyz.normalize();
  material.depthNode = Fn((builder) => {
    if (!builder.geometry?.hasAttribute('wetness')) return actualDepth;
    // Mixed dry coast faces keep their real height and cliffs still occlude
    // water. Render-only vertical skirts must never become a sea-depth wall.
    const wet = attribute<'float'>('wetness', 'float').greaterThanEqual(0.9999);
    const upward = normalWorldGeometry.dot(radial).abs().greaterThanEqual(0.82);
    return select(wet.and(upward), seaDepth, actualDepth);
  })();
  material.planetMeanSeaDepthNode = seaDepth;
  material.userData.fusedOceanDepth = 'analytic-mean-sea';
  material.userData.oceanDepthRejectsDryCoastAndSkirts = true;
}

function addOrbitalWaterReflection(material: WeatherAwarePlanetMaterial, options: PlanetLandMaterialOptions): void {
  const weather = options.weatherNodes;
  if (!weather) return;
  const policy = PLANET_ORBITAL_WATER;
  const celestial = weather.celestialLighting;
  // The common Lambert lighting already built these one/two-sample cloud
  // rays. Reuse their exact nodes instead of tripling climate texture work.
  const cloudTransmission = material.planetWeatherTransmissionNode ?? vec3(1);
  const cloudSlots = [cloudTransmission.x, cloudTransmission.y, cloudTransmission.z] as const;
  const radial = options.bodyUpWorld ?? modelWorldMatrix
    .mul(vec4(options.bodyPositionMeters.normalize(), 0)).xyz.normalize();
  const view = cameraPosition.sub(positionWorld).normalize();
  const reflection = Fn((builder) => {
    if (!builder.geometry?.hasAttribute('wetness') || !builder.geometry.hasAttribute('waterDepth') ||
        !builder.geometry.hasAttribute('color')) return vec3(0);
    const wet = attribute<'float'>('wetness', 'float').clamp(0, 1)
      .smoothstep(policy.wetStart, policy.wetFull);
    const facetEligibility = normalWorldGeometry.dot(radial).abs()
      .smoothstep(policy.facetStart, policy.facetFull);
    const depthGain = float(1).sub(attribute<'float'>('waterDepth', 'float').clamp(0, 1)
      .mul(policy.depthAbsorption));
    const albedo = attribute<'vec3'>('color', 'vec3').clamp(0, 1);
    const fresnel = float(0.02).add(float(0.98)
      .mul(float(1).sub(radial.dot(view).clamp(0, 1)).pow(5)));
    let reflected: Node<'vec3'> = vec3(0);
    for (const slot of [0, 1, 2] as const) {
      const light = celestial.directions[slot].normalize();
      const solarCosine = radial.dot(light).max(0);
      const energy = celestial.irradiance[slot].clamp(0, policy.maximumSourceIrradiance)
        .mul(celestial.horizon[slot].clamp(0, 1))
        .mul(celestial.eclipse[slot].clamp(0, 1))
        .mul(cloudSlots[slot].clamp(0, 1));
      const radiance = celestial.colors[slot].rgb.clamp(0, 1)
        .mul(celestial.transmissionColors[slot].rgb.clamp(0, 1)).mul(energy);
      const lobe = reflect(light.negate(), radial).dot(view).clamp(0, 1).pow(policy.specularPower)
        .mul(fresnel.mul(policy.fresnelGain).add(policy.specularGain))
        .mul(solarCosine.smoothstep(0, policy.solarHorizonFull));
      reflected = reflected.add(radiance.mul(albedo.mul(solarCosine.mul(policy.scatterGain)).add(lobe)).mul(depthGain));
    }
    return reflected.clamp(0, policy.maximumLinearContribution).mul(wet).mul(facetEligibility);
  })();
  material.planetOrbitalWaterReflectionNode = reflection;
  material.emissiveNode = materialEmissive.add(reflection);
  material.userData.orbitalWaterReflection = 'real-source-bounded';
  material.userData.orbitalWaterSourceSlots = 3;
  material.userData.orbitalWaterDepthScaleMeters = policy.depthScaleMeters;
  material.userData.orbitalWaterMaximumLinearContribution = policy.maximumLinearContribution;
  material.userData.orbitalWaterReusesCloudTransmission = Boolean(material.planetWeatherTransmissionNode);
  material.userData.orbitalWaterRejectsSkirtWalls = true;
}

/**
 * Three r185 copies only properties present on a fresh node-material instance.
 * Our supported weather hooks and their public graph slots are added later,
 * so a plain clone silently loses haze and source-specific cloud shadows.
 * Keep the graph references (and their live uniforms) shared while retaining
 * the clone's own material state and caller-replaceable coverage/depth slots.
 */
export function clonePlanetLandMaterial<T extends Material>(source: T): T {
  const cloned = source.clone();
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    const value = descriptor.value as { isNode?: boolean } | null | undefined;
    if (!name.startsWith('_') && name.endsWith('Node') &&
        (value === null || value?.isNode === true)) {
      Object.defineProperty(cloned, name, descriptor);
    }
  }
  for (const name of ['setupLightingModel', 'setupOutput'] as const) {
    const descriptor = descriptors[name];
    if (descriptor) Object.defineProperty(cloned, name, descriptor);
  }

  const cacheKey = descriptors.customProgramCacheKey;
  const sourceHasNodeAwareLegacyKey = source.userData.nodeAwareProgramCacheKey === true;
  if (cacheKey && !sourceHasNodeAwareLegacyKey) {
    Object.defineProperty(cloned, 'customProgramCacheKey', cacheKey);
  }
  // Registers legacy clones with the normal cache guard. For native node
  // materials this is a no-op: their public node slots already form the key.
  useNodeAwareMaterialCacheKey(cloned);
  if (cacheKey && sourceHasNodeAwareLegacyKey) {
    Object.defineProperty(cloned, 'customProgramCacheKey', cacheKey);
  }
  cloned.needsUpdate = true;
  return cloned;
}

/**
 * The same native node-material contract for globe, streamed land, and contact.
 * Geometry owns its linear color attribute; this layer owns common emission,
 * genuine stellar/cloud lighting, optional haze, and caller-owned coverage.
 */
export function createPlanetLandMaterial(
  field: PlanetField,
  options: PlanetLandMaterialOptions,
): MeshLambertNodeMaterial {
  if (!Number.isFinite(options.metersPerRenderUnit) || options.metersPerRenderUnit <= 0) {
    throw new RangeError('Planet land materials need a finite positive meter conversion.');
  }
  const palette = createSurfaceTerrainPalette(field);
  const material = new MeshLambertNodeMaterial({
    color: '#FFFFFF',
    vertexColors: true,
    flatShading: options.flatShading ?? true,
    ...(options.side === undefined ? {} : { side: options.side }),
    emissive: palette.emissiveHex,
    emissiveIntensity: palette.emissiveIntensity,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  material.colorNode = options.colorNode ?? vec3(1);
  if (options.maskNode !== undefined) material.maskNode = options.maskNode;
  if (options.depthNode !== undefined) material.depthNode = options.depthNode;
  if (options.weatherNodes) {
    applyPlanetWeatherToLambertMaterial(material, options.weatherNodes, {
      bodyPositionMeters: options.bodyPositionMeters,
      metersPerRenderUnit: options.metersPerRenderUnit,
      bodyUpWorld: options.bodyUpWorld,
      haze: options.haze,
    });
  }
  if (options.orbitalWater && (field.archetype === 'ocean' || field.archetype === 'temperate')) {
    addOrbitalWaterReflection(material, options);
  }
  if (options.fusedOceanDepth && (field.archetype === 'ocean' || field.archetype === 'temperate')) {
    addFusedOceanDepth(material, field, options);
  }
  material.userData.planetAppearancePolicy = PLANET_APPEARANCE_POLICY;
  material.userData.linearPlanetVertexColors = true;
  material.userData.sharedPlanetLandAppearance = true;
  material.userData.geologicalPalette = palette.geologicalPalette;
  material.userData.planetFieldSeed = field.seed;
  material.userData.planetArchetype = field.archetype;
  return material;
}
