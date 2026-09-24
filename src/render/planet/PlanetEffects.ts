import * as THREE from 'three';
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  mix,
  modelWorldMatrix,
  normalWorld,
  positionLocal,
  positionWorld,
  reflect,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { GRAVITATIONAL_CONSTANT, SeededRandom } from '../../core';
import { createPlanetField, samplePlanetClimate, samplePlanetField } from '../../fields';
import type { PlanetField, PlanetSurfaceSample } from '../../fields';
import { createPlanetWeather, type PlanetWeatherField, type PlanetWeatherSample } from '../../fields/PlanetWeather';
import type { CelestialLightFrame } from '../../lighting';
import {
  atmosphereSurfaceDensity,
  hasRenderableAtmosphere,
  PLANET_CLOUD_TERRAIN_CLEARANCE_METERS,
  supportsAtmosphericClouds,
  type PlanetDescriptor,
} from '../../universe';
import { AtmosphericWeather, weatherSurfaceHeightMeters, type PlanetWeatherState } from './AtmosphericWeather';
import type { PlanetWeatherNodes } from './PlanetWeatherNodes';
import { planetCloudAppearance } from './PlanetCloudAppearance';
import { SURFACE_LOG_DEPTH_QUANTUM, SURFACE_OCEAN_LEVEL_METERS } from './SurfacePatch';
import {
  createCelestialNodeLighting,
  updateCelestialNodeLighting,
  type CelestialNodeLighting,
} from '../lighting/CelestialNodeLighting';
import { PALETTE } from '../style/Palette';
import { createSurfaceTerrainPalette, samplePlanetWaterColor } from '../../terrain/SurfaceTerrainPresentation';
import { samplePlanetProxyWaterFacetTone } from '../../terrain/PlanetProxyGeometry';
import { planetMeanSeaLogDepth, type PlanetOceanDepthNodes } from './PlanetOceanDepth';
import {
  createSurfacePatchCoverageSetMask,
  type SurfacePatchCoverage,
} from './SurfacePatchCoverage';

export type { PlanetWeatherState } from './AtmosphericWeather';

export interface PlanetEffects {
  atmosphere: THREE.Mesh;
  skyGlow: THREE.Mesh;
  clouds: THREE.Group;
  ocean: THREE.Mesh;
  rings?: THREE.Group;
  weather: PlanetWeatherState;
  update: (elapsed: number) => void;
  setObserver: (
    bodyFixedDirection: THREE.Vector3,
    altitudeMeters: number,
    elapsedSeconds?: number,
  ) => PlanetWeatherState;
  setStarDirections: (
    primaryWorld: THREE.Vector3,
    secondaryWorld?: THREE.Vector3,
    primaryColor?: THREE.ColorRepresentation,
    secondaryColor?: THREE.ColorRepresentation,
  ) => void;
  /** Bind only actual system stars, their real horizon, atmosphere, and eclipses. */
  setCelestialLighting: (frame: CelestialLightFrame) => void;
  setPresentation: (surfaceBlend: number) => void;
  /** Additional apparent-size/residency fade for the two orbital cloud draws only. */
  setOrbitalCloudVisibility: (visibility: number) => void;
  /** A real terrain-LOD handoff strength in [0, 1], never an opaque screen overlay. */
  setTerrainTransition: (transitionStrength: number) => void;
  /** Hide global water only below a real, opaque body-fixed local surface patch. */
  setSurfaceCutout: (bodyFixedDirection: THREE.Vector3, cosine: number) => void;
  /** Exact union of published opaque local terrain, including square corners. */
  setSurfaceCoverage: (coverage: readonly SurfacePatchCoverage[]) => void;
  /** Share the current worker-produced globe buffers; never resample its ocean. */
  setProxyGeometry: (geometry: THREE.BufferGeometry) => void;
  /** Match both sides of a real globe-resolution transition. */
  setProxyTransition: (transition: PlanetOceanProxyTransition) => void;
}

export interface PlanetOceanProxyTransition {
  readonly outgoingGeometry: THREE.BufferGeometry | null;
  readonly incomingMask: Node<'bool'>;
  readonly outgoingMask: Node<'bool'>;
}

export interface PlanetEffectsOptions {
  /** Match the real proxy's Three IcosahedronGeometry detail exactly. */
  readonly oceanSubdivisions?: number;
  /** Product path: the matching globe geometry carries its own sampled water attributes. */
  readonly proxyGeometry?: THREE.BufferGeometry;
  /** Reuse the exact authoritative terrain field instead of rebuilding it. */
  readonly field?: PlanetField;
  /** One deterministic body-fixed climate field shared by orbit and ground. */
  readonly weatherField?: PlanetWeatherField;
  /** The same stable TSL density/shadow bridge used by the local terrain. */
  readonly weatherNodes?: PlanetWeatherNodes;
  /** Shared camera-relative sea-depth owner for this actual moving body. */
  readonly oceanDepth?: PlanetOceanDepthNodes;
}

interface CloudWeatherSample {
  direction: { x: number; y: number; z: number };
  moisture: number;
  continentalness: number;
  radius: number;
  cloudDensity?: number;
  stormIntensity?: number;
  cloudBaseMeters?: number;
  cloudTopMeters?: number;
  terrainHeightMeters?: number;
  verticalRadiusMeters?: number;
  wispAltitudeMeters?: number;
  wispVerticalRadiusMeters?: number;
}

const CLOUD_CORE_OPACITY = 0.18;
const CLOUD_WISP_OPACITY = 0.085;
const SHARED_ORBITAL_CORE_OPACITY = 0.34;
const SHARED_ORBITAL_WISP_OPACITY = 0.19;

/** Live TSL uniforms remain inspectable without pretending to be GLSL materials. */
export type PlanetNodeMaterial = MeshBasicNodeMaterial & {
  readonly uniforms: Record<string, THREE.IUniform>;
};

function createEffectMaterial(
  uniforms: Record<string, THREE.IUniform>,
  options: ConstructorParameters<typeof MeshBasicNodeMaterial>[0],
): PlanetNodeMaterial {
  const material = Object.assign(new MeshBasicNodeMaterial(options), { uniforms });
  material.userData.tsl = true;
  return material;
}

/** Stable aliases preserve every existing binary uniform and its exact identity. */
function celestialUniforms(celestial: CelestialNodeLighting) {
  return {
    primaryLightDirection: celestial.directions[0],
    secondaryLightDirection: celestial.directions[1],
    tertiaryLightDirection: celestial.directions[2],
    primaryStarColor: celestial.colors[0],
    secondaryStarColor: celestial.colors[1],
    tertiaryStarColor: celestial.colors[2],
    primaryIrradiance: celestial.irradiance[0],
    secondaryIrradiance: celestial.irradiance[1],
    tertiaryIrradiance: celestial.irradiance[2],
    primaryHorizonVisibility: celestial.horizon[0],
    secondaryHorizonVisibility: celestial.horizon[1],
    tertiaryHorizonVisibility: celestial.horizon[2],
    primaryTransmittance: celestial.transmittance[0],
    secondaryTransmittance: celestial.transmittance[1],
    tertiaryTransmittance: celestial.transmittance[2],
    primaryTransmissionColor: celestial.transmissionColors[0],
    secondaryTransmissionColor: celestial.transmissionColors[1],
    tertiaryTransmissionColor: celestial.transmissionColors[2],
    primaryEclipseVisibility: celestial.eclipse[0],
    secondaryEclipseVisibility: celestial.eclipse[1],
    tertiaryEclipseVisibility: celestial.eclipse[2],
    celestialDaylight: celestial.daylight,
    activeCelestialSources: celestial.activeCount,
  };
}

function tagCelestialMaterial(material: PlanetNodeMaterial, celestial: CelestialNodeLighting): void {
  material.userData.celestialLighting = celestial;
  material.userData.celestialSourceSlots = 3;
  material.userData.actualCelestialSourceIds = celestial.sourceIds;
  material.userData.physicalCelestialLighting = true;
  material.userData.physicalCelestialEclipses = true;
}

function createAtmosphere(
  planet: PlanetDescriptor,
  radius: number,
  celestial: CelestialNodeLighting,
  secondaryStrength: { value: number },
): THREE.Mesh {
  // The descriptor supplies the atmospheric boundary. Thin worlds must not
  // inherit an Earth-like minimum shell thickness.
  const atmosphereHeight = THREE.MathUtils.clamp(
    planet.atmosphere.heightMeters / planet.radiusMeters,
    0,
    0.044,
  );
  const nodes = {
    glowColor: uniform(new THREE.Color(planet.colors.atmosphere)),
    twilightColor: uniform(new THREE.Color(planet.colors.accent)),
    limbColor: uniform(new THREE.Color(planet.colors.atmosphere).lerp(new THREE.Color('#00EAFF'), 0.66)),
    bodyRadius: uniform(radius),
    atmosphereDensity: uniform(atmosphereSurfaceDensity(planet.atmosphere)),
    ...celestialUniforms(celestial),
    secondaryStrength: uniform(secondaryStrength.value),
    presentationOpacity: uniform(1),
    observerDensity: uniform(0),
    cloudDensity: uniform(0),
    terrainTransition: uniform(0),
    observerAltitudeRatio: uniform(1),
    aerialPerspective: uniform(0),
    observerClearance: uniform(0),
    weatherHumidity: uniform(0),
  };
  const material = createEffectMaterial(nodes, {
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  tagCelestialMaterial(material, celestial);
  material.fragmentNode = Fn(() => {
    const center = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const observerOffset = cameraPosition.sub(center);
    const observerDistance = observerOffset.length().max(nodes.bodyRadius);
    const curvedHorizonDrop = float(1)
      .sub(nodes.bodyRadius.div(observerDistance).pow(2))
      .max(0)
      .sqrt();
    const surfaceNormal = normalWorld.normalize();
    const sight = cameraPosition.sub(positionWorld).normalize();
    const facing = float(1).sub(sight.dot(surfaceNormal).abs()).max(0).toVar();
    // Final opacity already multiplies smoothstep(0.7, 0.84, facing). Reject
    // the identical transparent sphere interior before three-star scattering.
    facing.lessThanEqual(0.7).discard();
    const rim = facing.pow(3.4);
    const edge = facing.pow(9);
    const razor = facing.pow(31);
    const filament = facing.pow(78);
    const primaryVisibility = nodes.primaryIrradiance.max(0).min(3.2)
      .mul(nodes.primaryHorizonVisibility)
      .mul(nodes.primaryTransmittance)
      .mul(nodes.primaryEclipseVisibility);
    const secondaryVisibility = nodes.secondaryIrradiance.max(0).min(3.2)
      .mul(nodes.secondaryHorizonVisibility)
      .mul(nodes.secondaryTransmittance)
      .mul(nodes.secondaryEclipseVisibility)
      .mul(nodes.secondaryStrength);
    const tertiaryVisibility = nodes.tertiaryIrradiance.max(0).min(3.2)
      .mul(nodes.tertiaryHorizonVisibility)
      .mul(nodes.tertiaryTransmittance)
      .mul(nodes.tertiaryEclipseVisibility);
    const day = surfaceNormal.dot(nodes.primaryLightDirection.normalize()).max(0)
      .mul(primaryVisibility);
    const secondaryDay = surfaceNormal.dot(nodes.secondaryLightDirection.normalize())
      .max(0).mul(secondaryVisibility);
    const tertiaryDay = surfaceNormal.dot(nodes.tertiaryLightDirection.normalize())
      .max(0).mul(tertiaryVisibility);
    const terminator = surfaceNormal.dot(nodes.primaryLightDirection.normalize())
      .abs().mul(-8.8).exp();
    const physicalEntry = nodes.observerDensity.mul(
      float(1).sub(nodes.observerAltitudeRatio.smoothstep(0.82, 1)),
    );
    const actualHorizon = sight.negate().dot(observerOffset.normalize()).add(curvedHorizonDrop);
    const physicalLimb = float(1).sub(actualHorizon.abs().mul(8)).max(0).pow(2);
    const horizonVeil = facing.pow(5.3)
      .mul(facing.smoothstep(0.64, 0.88))
      .mul(physicalLimb.mul(0.68).add(0.32));
    const handoff = nodes.terrainTransition.mul(physicalEntry).mul(horizonVeil);
    const rayleighPhase = float(0.75).mul(float(1).add(sight.dot(surfaceNormal).pow(2)));
    const primaryForward = sight.negate().dot(nodes.primaryLightDirection.normalize())
      .max(0).pow(17).mul(primaryVisibility);
    const secondaryForward = sight.negate().dot(nodes.secondaryLightDirection.normalize())
      .max(0).pow(21).mul(secondaryVisibility);
    const tertiaryForward = sight.negate().dot(nodes.tertiaryLightDirection.normalize())
      .max(0).pow(24).mul(tertiaryVisibility);
    const humidMie = primaryForward.mul(0.14).add(secondaryForward.mul(0.085))
      .add(tertiaryForward.mul(0.065))
      .mul(nodes.weatherHumidity.mul(0.62).add(0.18))
      .mul(nodes.aerialPerspective)
      .mul(edge);
    const primarySpectral = nodes.primaryStarColor.rgb.mul(
      nodes.primaryTransmissionColor.rgb.div(nodes.primaryTransmittance.max(0.0001)),
    );
    const secondarySpectral = nodes.secondaryStarColor.rgb.mul(
      nodes.secondaryTransmissionColor.rgb.div(nodes.secondaryTransmittance.max(0.0001)),
    );
    const tertiarySpectral = nodes.tertiaryStarColor.rgb.mul(
      nodes.tertiaryTransmissionColor.rgb.div(nodes.tertiaryTransmittance.max(0.0001)),
    );
    const sunLight = primarySpectral.mul(day)
      .add(secondarySpectral.mul(secondaryDay).mul(0.58))
      .add(tertiarySpectral.mul(tertiaryDay).mul(0.43));
    // A genuine forward-scattered atmospheric shaft exists only where an
    // actual visible star meets this body's humid, planet-fixed cloud layer.
    const cloudShaft = nodes.cloudDensity.mul(nodes.weatherHumidity.mul(0.52).add(0.24))
      .mul(nodes.observerDensity)
      .mul(rim)
      .mul(primaryForward.mul(0.21).add(secondaryForward.mul(0.14)).add(tertiaryForward.mul(0.11)));
    const molecularTint = mix(nodes.glowColor, nodes.twilightColor, terminator.mul(edge.mul(0.07).add(0.11)));
    const scattering = mix(molecularTint, nodes.limbColor, edge.mul(0.67).add(razor.mul(0.27)).min(0.94))
      .add(sunLight.mul(terminator).mul(rim).mul(0.065))
      .add(nodes.twilightColor.mul(nodes.cloudDensity).mul(rim).mul(0.07))
      .add(mix(nodes.glowColor, nodes.twilightColor, terminator.mul(0.34)).mul(handoff).mul(0.19))
      .add(primarySpectral.mul(humidMie))
      .add(secondarySpectral.mul(secondaryForward).mul(nodes.aerialPerspective).mul(edge).mul(0.075))
      .add(tertiarySpectral.mul(tertiaryForward).mul(nodes.aerialPerspective).mul(edge).mul(0.057))
      .add(sunLight.mul(cloudShaft))
      .mul(rayleighPhase.mul(0.16).add(0.84));
    const luma = scattering.dot(vec3(0.2126, 0.7152, 0.0722));
    const vividScattering = mix(vec3(luma), scattering, 1.22).max(vec3(0));
    const lighting = day.mul(0.68).add(secondaryDay.mul(0.28)).add(tertiaryDay.mul(0.19))
      .add(nodes.celestialDaylight.mul(0.13).add(0.26))
      .mul(nodes.observerDensity.mul(0.12).add(1));
    const alpha = rim.mul(0.56).add(edge.mul(1.19)).add(razor.mul(0.95)).add(filament.mul(0.64))
      .mul(nodes.atmosphereDensity).add(handoff.mul(0.12)).mul(lighting).min(0.91)
      .mul(facing.smoothstep(0.7, 0.84)).mul(nodes.presentationOpacity);
    alpha.lessThan(0.004).discard();
    return vec4(vividScattering.mul(edge.mul(0.51).add(razor.mul(0.43)).add(0.94)), alpha);
  })();
  material.userData.rimPowers = [3.4, 9, 31, 78];
  material.userData.rayleighScattering = true;
  material.userData.binaryStarMieScattering = true;
  material.userData.tripleStarMieScattering = true;
  material.userData.physicalAtmosphericCloudShafts = true;
  material.userData.eclipseAwareScattering = true;
  material.userData.physicalAerialPerspective = true;
  material.userData.horizonVeil = true;
  material.userData.physicalCurvedHorizon = true;
  const atmosphere = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius * (1 + atmosphereHeight), hasRenderableAtmosphere(planet.atmosphere) ? 4 : 0),
    material,
  );
  atmosphere.name = `${planet.name} / atmosphere`;
  atmosphere.renderOrder = 4;
  atmosphere.userData.physicalHeightRatio = atmosphereHeight;
  atmosphere.userData.crispFresnelLimb = true;
  atmosphere.userData.physicalObserverScattering = true;
  atmosphere.userData.physicalTerrainTransition = true;
  atmosphere.userData.physicalCelestialLighting = true;
  atmosphere.userData.celestialSourceSlots = 3;
  atmosphere.userData.atmosphereRegime = planet.atmosphere.regime;
  atmosphere.visible = hasRenderableAtmosphere(planet.atmosphere);
  return atmosphere;
}

function createTwilightSky(
  planet: PlanetDescriptor,
  radius: number,
  celestial: CelestialNodeLighting,
  secondaryStrength: { value: number },
): THREE.Mesh {
  const nodes = {
    horizonColor: uniform(new THREE.Color(planet.colors.atmosphere)),
    twilightColor: uniform(new THREE.Color(planet.colors.accent)),
    bodyRadius: uniform(radius),
    ...celestialUniforms(celestial),
    secondaryStrength: uniform(secondaryStrength.value),
    atmosphereDensity: uniform(atmosphereSurfaceDensity(planet.atmosphere)),
    presentationOpacity: uniform(0),
    observerDensity: uniform(0),
    cloudDensity: uniform(0),
    terrainTransition: uniform(0),
    observerAltitudeRatio: uniform(1),
    aerialPerspective: uniform(0),
    observerClearance: uniform(0),
    weatherHumidity: uniform(0),
  };
  const material = createEffectMaterial(nodes, {
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  tagCelestialMaterial(material, celestial);
  material.fragmentNode = Fn(() => {
    const center = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const observerOffset = cameraPosition.sub(center);
    const observerDistance = observerOffset.length().max(nodes.bodyRadius);
    const surfaceUp = observerOffset.normalize();
    const sight = positionWorld.sub(cameraPosition).normalize();
    // A 120 km observer sees an Earth-radius horizon 11 degrees below the
    // tangent. Anchoring all scattering at elevation zero detached the sky.
    const curvedHorizonDrop = float(1)
      .sub(nodes.bodyRadius.div(observerDistance).pow(2))
      .max(0)
      .sqrt();
    const elevation = sight.dot(surfaceUp);
    const horizonElevation = elevation.add(curvedHorizonDrop).toVar();
    const horizon = float(1).sub(horizonElevation.abs().mul(4.7)).max(0).pow(2.35);
    const sky = horizonElevation.smoothstep(-0.035, 0.038);
    // Every term in the final horizon opacity contains this exact sky mask.
    sky.lessThanEqual(0).discard();
    const lowerSky = float(1).sub(horizonElevation.max(0).div(0.7))
      .max(0).pow(1.32);
    const primaryVisibility = nodes.primaryIrradiance.max(0).min(3.2)
      .mul(nodes.primaryHorizonVisibility)
      .mul(nodes.primaryTransmittance)
      .mul(nodes.primaryEclipseVisibility);
    const secondaryVisibility = nodes.secondaryIrradiance.max(0).min(3.2)
      .mul(nodes.secondaryHorizonVisibility)
      .mul(nodes.secondaryTransmittance)
      .mul(nodes.secondaryEclipseVisibility)
      .mul(nodes.secondaryStrength);
    const tertiaryVisibility = nodes.tertiaryIrradiance.max(0).min(3.2)
      .mul(nodes.tertiaryHorizonVisibility)
      .mul(nodes.tertiaryTransmittance)
      .mul(nodes.tertiaryEclipseVisibility);
    const primaryDot = sight.dot(nodes.primaryLightDirection.normalize()).max(0);
    const secondaryDot = sight.dot(nodes.secondaryLightDirection.normalize()).max(0);
    const tertiaryDot = sight.dot(nodes.tertiaryLightDirection.normalize()).max(0);
    const alignment = primaryDot.pow(3.6).mul(primaryVisibility);
    const secondaryAlignment = secondaryDot.pow(4.1).mul(secondaryVisibility);
    const tertiaryAlignment = tertiaryDot.pow(4.4).mul(tertiaryVisibility);
    const primarySunset = float(1).sub(surfaceUp.dot(nodes.primaryLightDirection.normalize())
      .smoothstep(-0.17, 0.39)).mul(primaryVisibility);
    const secondarySunset = float(1).sub(surfaceUp.dot(nodes.secondaryLightDirection.normalize())
      .smoothstep(-0.17, 0.39)).mul(secondaryVisibility);
    const tertiarySunset = float(1).sub(surfaceUp.dot(nodes.tertiaryLightDirection.normalize())
      .smoothstep(-0.17, 0.39)).mul(tertiaryVisibility);
    const primaryFlare = primaryDot.pow(39)
      .mul(primarySunset.mul(0.72).add(primaryVisibility.mul(0.18)));
    const secondaryFlare = secondaryDot.pow(47).mul(secondarySunset);
    const tertiaryFlare = tertiaryDot.pow(51).mul(tertiarySunset);
    const magentaHorizon = horizonElevation.sub(0.029).div(0.049).pow(2).negate().exp();
    const cyanLimb = horizonElevation.sub(0.007).div(0.017).pow(2).negate().exp();
    const entryDensity = nodes.observerDensity.mul(
      float(1).sub(nodes.observerAltitudeRatio.smoothstep(0.86, 1)),
    );
    const transitionRibbon = horizonElevation.sub(0.018).div(0.06).pow(2).negate().exp()
      .mul(nodes.terrainTransition).mul(entryDensity);
    const primarySpectral = nodes.primaryStarColor.rgb.mul(
      nodes.primaryTransmissionColor.rgb.div(nodes.primaryTransmittance.max(0.0001)),
    );
    const secondarySpectral = nodes.secondaryStarColor.rgb.mul(
      nodes.secondaryTransmissionColor.rgb.div(nodes.secondaryTransmittance.max(0.0001)),
    );
    const tertiarySpectral = nodes.tertiaryStarColor.rgb.mul(
      nodes.tertiaryTransmissionColor.rgb.div(nodes.tertiaryTransmittance.max(0.0001)),
    );
    const transitionTint = mix(
      nodes.horizonColor,
      nodes.twilightColor,
      primarySunset.mul(0.18).add(secondarySunset.mul(0.09)).add(tertiarySunset.mul(0.065)).add(0.28).min(1),
    ).add(primarySpectral.mul(alignment)
      .add(secondarySpectral.mul(secondaryAlignment).mul(0.64))
      .add(tertiarySpectral.mul(tertiaryAlignment).mul(0.48))
      .mul(0.095));
    // Only a thin real horizon receives saturated twilight. The old broad
    // additive accent painted a flat pink-white wall across every landing.
    // True linear atmospheric radiance must clear the presentation pass's
    // 0.016 shadow toe; otherwise a physically dense violet sky turns black.
    const daytimeViolet = mix(vec3(0.13, 0.039, 0.34), nodes.horizonColor, 0.18);
    const nightIndigo = mix(vec3(0.047, 0.018, 0.125), nodes.twilightColor, 0.065);
    const deepSky = mix(nightIndigo, daytimeViolet,
      nodes.celestialDaylight.mul(0.83).add(0.08).min(1));
    const sunsetEnergy = primarySunset.mul(0.54)
      .add(secondarySunset.mul(0.31))
      .add(tertiarySunset.mul(0.23))
      .add(nodes.celestialDaylight.mul(0.055))
      .min(1);
    const physicalColumn = nodes.aerialPerspective.mul(0.67)
      .add(nodes.observerDensity.mul(0.2))
      .add(nodes.atmosphereDensity.mul(0.067))
      .min(0.9);
    const molecularSky = lowerSky.mul(physicalColumn);
    const cloudBreak = float(1).sub(nodes.cloudDensity.mul(0.64)).max(0.2);
    const actualSunShafts = primaryDot.pow(17).mul(primaryVisibility)
      .add(secondaryDot.pow(21).mul(secondaryVisibility).mul(0.68))
      .add(tertiaryDot.pow(24).mul(tertiaryVisibility).mul(0.49))
      .mul(nodes.aerialPerspective)
      .mul(nodes.weatherHumidity.mul(0.62).add(0.17))
      .mul(cloudBreak)
      .mul(horizon.mul(0.53).add(lowerSky.mul(0.18)));
    const tint = deepSky.mul(horizon.mul(0.39).add(lowerSky.mul(0.76)).add(0.22))
      .add(nodes.twilightColor.mul(magentaHorizon).mul(sunsetEnergy).mul(0.63))
      .add(nodes.horizonColor.mul(cyanLimb).mul(0.26))
      .add(primarySpectral.mul(primaryFlare.mul(0.34)
        .add(primaryDot.pow(11).mul(primarySunset).mul(0.055))))
      .add(secondarySpectral.mul(secondaryFlare.mul(0.23)
        .add(secondaryDot.pow(14).mul(secondarySunset).mul(0.038))))
      .add(tertiarySpectral.mul(tertiaryFlare.mul(0.17)
        .add(tertiaryDot.pow(16).mul(tertiarySunset).mul(0.029))))
      .add(primarySpectral.mul(actualSunShafts).mul(0.14))
      .add(nodes.horizonColor.mul(nodes.aerialPerspective).mul(horizon).mul(0.075))
      .add(nodes.horizonColor.mul(molecularSky).mul(nodes.celestialDaylight.mul(0.085).add(0.018)))
      .add(nodes.twilightColor.mul(molecularSky).mul(sunsetEnergy).mul(0.145))
      .add(nodes.twilightColor.mul(nodes.weatherHumidity).mul(nodes.cloudDensity)
        .mul(magentaHorizon).mul(0.045))
      .add(transitionTint.mul(transitionRibbon).mul(0.095));
    const horizonLine = float(1).sub(horizonElevation.abs().mul(19)).max(0).pow(3.5);
    const alpha = horizon.mul(0.135).add(horizonLine.mul(0.14)).add(magentaHorizon.mul(0.075))
      .add(cyanLimb.mul(0.065)).add(transitionRibbon.mul(0.075)).mul(sky)
      .add(molecularSky.mul(0.58).mul(sky))
      .mul(alignment.mul(0.15).add(secondaryAlignment.mul(0.095)).add(tertiaryAlignment.mul(0.07))
        .add(nodes.celestialDaylight.mul(0.24).add(0.51)))
      .mul(nodes.atmosphereDensity).mul(nodes.presentationOpacity)
      .mul(nodes.aerialPerspective.mul(0.1).add(nodes.cloudDensity.mul(0.075)).add(1))
      .min(0.4);
    return vec4(tint, alpha);
  })();
  material.userData.binaryStarSunset = true;
  material.userData.tripleStarSunset = true;
  material.userData.eclipseAwareSunset = true;
  material.userData.physicalAtmosphericSunShafts = true;
  material.userData.magentaHorizon = true;
  material.userData.transitionRibbon = true;
  material.userData.restrainedBinaryTwilight = true;
  material.userData.physicalCurvedHorizon = true;
  material.userData.physicalMolecularMidSky = true;
  material.userData.maximumHorizonOpacity = 0.4;
  const skyGlow = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 1.19,
    hasRenderableAtmosphere(planet.atmosphere) ? 3 : 0), material);
  skyGlow.name = `${planet.name} / planet-centered twilight horizon`;
  skyGlow.visible = false;
  skyGlow.renderOrder = 5;
  skyGlow.userData.actualBinaryStarLighting = true;
  skyGlow.userData.actualTripleStarLighting = true;
  skyGlow.userData.physicalCelestialLighting = true;
  skyGlow.userData.physicalTerrainTransition = true;
  skyGlow.userData.atmosphereRegime = planet.atmosphere.regime;
  return skyGlow;
}

function createOcean(
  planet: PlanetDescriptor,
  field: PlanetField,
  radius: number,
  celestial: CelestialNodeLighting,
  secondaryStrength: { value: number },
  oceanSubdivisions?: number,
  sharedProxyGeometry?: THREE.BufferGeometry,
  oceanDepth?: PlanetOceanDepthNodes,
): THREE.Mesh {
  const potentiallyWet = planet.archetype === 'ocean' || planet.archetype === 'temperate';
  // The orbital shell and close-up simulated waves share one physical mean
  // sea level. Mismatched flat icosahedron faces have kilometer-scale chord
  // differences, so preserve the exact actual proxy topology rather than
  // hiding their intersections behind a falsely elevated 159 m water shell.
  // Standalone callers may still request the historical subdivision. Product
  // bodies reuse the worker-produced globe, including its sampled wet mask.
  const subdivision = potentiallyWet
    ? THREE.MathUtils.clamp(Math.round(oceanSubdivisions ?? 14), 2, 16)
    : 2;
  const physicalSeaRadius = radius * (1 + SURFACE_OCEAN_LEVEL_METERS / planet.radiusMeters);
  const sharesProxy = potentiallyWet && sharedProxyGeometry?.hasAttribute('waterColor') === true;
  // Dry worlds keep an empty effect handle for the common lighting/update
  // contract. They must not sample an ocean they can never render.
  const geometry = !potentiallyWet
    ? new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    : sharesProxy ? sharedProxyGeometry! : new THREE.IcosahedronGeometry(physicalSeaRadius, subdivision);
  const positions = geometry.getAttribute('position');
  const cache = new Map<string, PlanetSurfaceSample>();
  let wetVertexCount = 0;
  if (!sharesProxy) {
    const wetness = new Float32Array(positions.count);
    const depth = new Float32Array(positions.count);
    const facets = new Float32Array(positions.count);
    const colors = new Float32Array(positions.count * 3);
    const palette = createSurfaceTerrainPalette(field);
    const direction = new THREE.Vector3();
    const faceCenter = new THREE.Vector3();
    let facet = 0;
    for (let index = 0; index < positions.count; index += 1) {
      if (index % 3 === 0) {
        faceCenter.set(
          positions.getX(index) + positions.getX(index + 1) + positions.getX(index + 2),
          positions.getY(index) + positions.getY(index + 1) + positions.getY(index + 2),
          positions.getZ(index) + positions.getZ(index + 1) + positions.getZ(index + 2),
        );
        facet = samplePlanetProxyWaterFacetTone(faceCenter, planet.seed);
      }
      direction.fromBufferAttribute(positions, index).normalize();
      const key = `${direction.x.toFixed(7)}:${direction.y.toFixed(7)}:${direction.z.toFixed(7)}`;
      let sample = cache.get(key);
      if (!sample) {
        sample = samplePlanetClimate(field, direction);
        cache.set(key, sample);
      }
      const wet = potentiallyWet && sample.ocean;
      wetness[index] = wet ? 1 : 0;
      if (wet) wetVertexCount += 1;
      depth[index] = THREE.MathUtils.clamp(sample.waterDepthMeters / 1_650, 0, 1);
      facets[index] = facet;
      const tint = samplePlanetWaterColor(palette, field, sample, direction,
        field.radius / (subdivision + 1));
      colors.set(tint, index * 3);
    }
    const waterColor = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('color', waterColor);
    geometry.setAttribute('waterColor', waterColor);
    geometry.setAttribute('wetness', new THREE.BufferAttribute(wetness, 1));
    geometry.setAttribute('waterDepth', new THREE.BufferAttribute(depth, 1));
    geometry.setAttribute('facetTone', new THREE.BufferAttribute(facets, 1));
  } else {
    wetVertexCount = Number(geometry.userData.sharedFieldWetVertices ?? 0);
  }

  const nodes = {
    time: uniform(0),
    ...celestialUniforms(celestial),
    secondaryStrength: uniform(secondaryStrength.value),
    shorelineColor: uniform(new THREE.Color(PALETTE.mint)),
    surfaceCutoutDirection: uniform(new THREE.Vector3(0, 1, 0)),
    surfaceCutoutCosine: uniform(2),
  };
  const material = createEffectMaterial(nodes, {
    vertexColors: false,
    transparent: true,
    // The authoritative proxy owns the base ocean/land color; this pass adds
    // physically anchored water reflections without darkening dry terrain.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  // A shared proxy includes real raised land vertices. Its reflection pass
  // projects those directions to the one physical sea datum in the shader;
  // no second position buffer, resampling pass, or elevated fake ocean.
  material.positionNode = positionLocal.normalize().mul(physicalSeaRadius);
  // Wet proxy faces and this exact-topology reflection pass now share the
  // field's genuine zero-meter datum. Resolve their float32 coplanarity in
  // logarithmic depth instead of lifting the ocean above a walkable shore.
  material.depthNode = planetMeanSeaLogDepth(physicalSeaRadius, positionLocal, oceanDepth)
    .sub(SURFACE_LOG_DEPTH_QUANTUM);
  material.userData.oceanDepthPolicy = 'analytic-mean-sea';
  material.userData.fragmentDepthBias = SURFACE_LOG_DEPTH_QUANTUM;
  material.userData.depthQuanta = 4;
  tagCelestialMaterial(material, celestial);
  material.fragmentNode = Fn((builder) => {
    // A custom fragmentNode bypasses Three r185's setupDiffuseColor, which
    // normally evaluates maskNode. Read the actual compiling material here:
    // outgoing ocean clones have a different complementary ownership mask.
    const visibility = (builder.material as PlanetNodeMaterial).maskNode as Node<'bool'> | null;
    if (visibility) visibility.not().discard();
    const localDirection = positionLocal.normalize();
    nodes.surfaceCutoutCosine.lessThan(1).and(
      localDirection.dot(nodes.surfaceCutoutDirection).greaterThan(nodes.surfaceCutoutCosine),
    ).discard();
    const wet = attribute<'float'>('wetness', 'float');
    wet.lessThan(0.17).discard();
    const depthValue = attribute<'float'>('waterDepth', 'float');
    const facet = attribute<'float'>('facetTone', 'float');
    const surfaceColor = attribute<'vec3'>('waterColor', 'vec3');
    const surfaceNormal = modelWorldMatrix.mul(vec4(localDirection, 0)).xyz.normalize();
    const primaryDirection = nodes.primaryLightDirection.normalize();
    const secondaryDirection = nodes.secondaryLightDirection.normalize();
    const tertiaryDirection = nodes.tertiaryLightDirection.normalize();
    const primaryVisibility = nodes.primaryIrradiance.max(0).min(3.2)
      .mul(nodes.primaryHorizonVisibility)
      .mul(nodes.primaryTransmittance)
      .mul(nodes.primaryEclipseVisibility);
    const secondaryVisibility = nodes.secondaryIrradiance.max(0).min(3.2)
      .mul(nodes.secondaryHorizonVisibility)
      .mul(nodes.secondaryTransmittance)
      .mul(nodes.secondaryEclipseVisibility)
      .mul(nodes.secondaryStrength);
    const tertiaryVisibility = nodes.tertiaryIrradiance.max(0).min(3.2)
      .mul(nodes.tertiaryHorizonVisibility)
      .mul(nodes.tertiaryTransmittance)
      .mul(nodes.tertiaryEclipseVisibility);
    const sunlight = surfaceNormal.dot(primaryDirection).max(0).mul(primaryVisibility);
    const secondSun = surfaceNormal.dot(secondaryDirection).max(0).mul(secondaryVisibility);
    const thirdSun = surfaceNormal.dot(tertiaryDirection).max(0).mul(tertiaryVisibility);
    const sight = cameraPosition.sub(positionWorld).normalize();
    const ripples = localDirection.x.mul(43).add(localDirection.z.mul(37)).add(nodes.time.mul(0.34)).sin()
      .mul(localDirection.y.mul(39).sub(nodes.time.mul(0.22)).sin());
    const sparkle = reflect(primaryDirection.negate(), surfaceNormal).dot(sight).max(0)
      .pow(24).mul(primaryVisibility);
    const secondarySparkle = reflect(secondaryDirection.negate(), surfaceNormal)
      .dot(sight).max(0).pow(31).mul(secondaryVisibility);
    const tertiarySparkle = reflect(tertiaryDirection.negate(), surfaceNormal)
      .dot(sight).max(0).pow(35).mul(tertiaryVisibility);
    const glint = sparkle.mul(0.76).add(secondarySparkle.mul(0.48)).add(tertiarySparkle.mul(0.35))
      .add(sunlight.min(1).pow(8).mul(0.08))
      .mul(ripples.add(1).mul(0.2).add(0.27)).mul(facet.mul(0.3).add(0.7));
    const angularFacet = facet.mul(6).floor().mul(0.018).add(0.94);
    const grazing = float(1).sub(sight.dot(surfaceNormal).max(0)).pow(2.7);
    const primarySpectral = nodes.primaryStarColor.rgb.mul(
      nodes.primaryTransmissionColor.rgb.div(nodes.primaryTransmittance.max(0.0001)),
    );
    const secondarySpectral = nodes.secondaryStarColor.rgb.mul(
      nodes.secondaryTransmissionColor.rgb.div(nodes.secondaryTransmittance.max(0.0001)),
    );
    const tertiarySpectral = nodes.tertiaryStarColor.rgb.mul(
      nodes.tertiaryTransmissionColor.rgb.div(nodes.tertiaryTransmittance.max(0.0001)),
    );
    const solarGlint = primarySpectral.mul(sparkle)
      .add(secondarySpectral.mul(secondarySparkle).mul(0.82))
      .add(tertiarySpectral.mul(tertiarySparkle).mul(0.67));
    const coverage = wet.smoothstep(0.17, 0.34);
    const coast = wet.smoothstep(0.17, 0.72);
    const foam = float(1).sub(wet.smoothstep(0.17, 0.71))
      .mul(float(1).sub(depthValue.mul(0.72)));
    const shorePhase = localDirection.dot(vec3(137, 83, 119)).add(nodes.time.mul(0.22));
    const shorelineFacet = shorePhase.sin().max(0).pow(9).mul(foam);
    const water = surfaceColor.mul(angularFacet)
      .mul(sunlight.mul(0.44).add(secondSun.mul(0.17)).add(thirdSun.mul(0.13))
        .add(nodes.celestialDaylight.mul(0.16).add(0.16)))
      .add(solarGlint.mul(glint.mul(0.61).add(0.13)).mul(float(1).sub(depthValue.mul(0.56))))
      .add(vec3(0.01, 0.69, 0.63).mul(glint.mul(0.37).add(grazing.mul(0.075))))
      .add(nodes.shorelineColor.mul(foam.mul(0.105).add(shorelineFacet.mul(0.27))));
    const alpha = coast.mul(0.16).add(glint.mul(0.11)).add(grazing.mul(0.035)).add(0.045)
      .mul(wet.mul(1.19).min(1)).mul(coverage).min(0.49);
    return vec4(water, alpha);
  })();
  material.userData.wetCutoff = 0.17;
  material.userData.shoreTransition = [0.17, 0.34];
  material.userData.shorelineFacet = true;
  material.userData.binaryStarReflections = true;
  material.userData.tripleStarReflections = true;
  material.userData.eclipseAwareReflections = true;
  material.userData.bodyFixedSurfaceCutout = true;
  material.userData.fragmentHonorsVisibilityMask = true;
  const ocean = new THREE.Mesh(geometry, material);
  ocean.name = `${planet.name} / procedural ocean`;
  ocean.visible = potentiallyWet;
  ocean.userData.physicalWaterSupported = potentiallyWet;
  ocean.userData.sharedFieldSeed = field.seed;
  ocean.userData.physicalSeaLevelMeters = SURFACE_OCEAN_LEVEL_METERS;
  ocean.userData.sharedFieldSamples = sharesProxy ? Number(geometry.userData.sharedFieldSamples ?? 0) : cache.size;
  ocean.userData.sharedFieldWetVertices = wetVertexCount;
  ocean.userData.facetedWater = true;
  ocean.userData.crispSharedFieldShoreline = true;
  ocean.userData.antialiasedSharedFieldCoastCoverage = true;
  ocean.userData.bodyFixedSurfaceCutout = true;
  ocean.userData.actualBinaryStarReflections = true;
  ocean.userData.actualTripleStarReflections = true;
  ocean.userData.physicalCelestialLighting = true;
  ocean.userData.sharedProxyGeometry = sharesProxy;
  ocean.userData.subdivision = sharesProxy ? Number(geometry.userData.proxySubdivisions ?? subdivision + 1) - 1 : subdivision;
  ocean.userData.triangleCount = positions.count / 3;
  return ocean;
}

function createSharedOrbitalCloudMaterial(
  planet: PlanetDescriptor,
  celestial: CelestialNodeLighting,
  weatherField: PlanetWeatherField,
  weatherNodes: PlanetWeatherNodes,
  layer: 'core' | 'wisp',
): PlanetNodeMaterial {
  const layerOpacity = (layer === 'core' ? SHARED_ORBITAL_CORE_OPACITY : SHARED_ORBITAL_WISP_OPACITY) *
    weatherField.cloudOpacityScale;
  const nodes = {
    ...celestialUniforms(celestial),
    layerOpacity: uniform(layerOpacity),
    presentationOpacity: uniform(1),
    horizonColor: uniform(new THREE.Color(planet.colors.atmosphere)),
    twilightColor: uniform(new THREE.Color(planet.colors.accent)),
  };
  const material = createEffectMaterial(nodes, {
    color: '#FFFFFF',
    transparent: true,
    opacity: layerOpacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    alphaTest: 0.0015,
  });

  // Instanced positionLocal already includes each real formation matrix. Its
  // parent follows the field's -Y wind advection, so recover the actual
  // body-fixed direction before sampling the very same terrain-shadow field.
  const localDirection = positionLocal.normalize();
  const windPhase = weatherNodes.time.mul(-weatherField.windAngularVelocityRadiansPerSecond);
  const cosine = windPhase.cos();
  const sine = windPhase.sin();
  const bodyFixedDirection = vec3(
    localDirection.x.mul(cosine).add(localDirection.z.mul(sine)),
    localDirection.y,
    localDirection.z.mul(cosine).sub(localDirection.x.mul(sine)),
  );
  const sharedDensity = weatherNodes.densityNode(bodyFixedDirection);
  const frontCoverage = sharedDensity.smoothstep(0.045, layer === 'core' ? 0.31 : 0.23);
  const stormCore = sharedDensity.smoothstep(0.47, 0.84);
  const normal = normalWorld.normalize();
  const sight = cameraPosition.sub(positionWorld).normalize();
  const facing = normal.dot(sight).abs();
  const rim = float(1).sub(facing).max(0).pow(2.45);
  const primaryVisibility = nodes.primaryIrradiance.min(2.8)
    .mul(nodes.primaryHorizonVisibility)
    .mul(nodes.primaryTransmittance)
    .mul(nodes.primaryEclipseVisibility);
  const secondaryVisibility = nodes.secondaryIrradiance.min(2.8)
    .mul(nodes.secondaryHorizonVisibility)
    .mul(nodes.secondaryTransmittance)
    .mul(nodes.secondaryEclipseVisibility);
  const tertiaryVisibility = nodes.tertiaryIrradiance.min(2.8)
    .mul(nodes.tertiaryHorizonVisibility)
    .mul(nodes.tertiaryTransmittance)
    .mul(nodes.tertiaryEclipseVisibility);
  const primaryFace = normal.dot(nodes.primaryLightDirection.normalize()).max(0)
    .mul(primaryVisibility);
  const secondaryFace = normal.dot(nodes.secondaryLightDirection.normalize()).max(0)
    .mul(secondaryVisibility);
  const tertiaryFace = normal.dot(nodes.tertiaryLightDirection.normalize()).max(0)
    .mul(tertiaryVisibility);
  const primaryForward = sight.negate().dot(nodes.primaryLightDirection.normalize())
    .max(0).pow(8).mul(primaryVisibility);
  const secondaryForward = sight.negate().dot(nodes.secondaryLightDirection.normalize())
    .max(0).pow(9).mul(secondaryVisibility);
  const silver = rim.mul(primaryForward.mul(1.12).add(secondaryForward.mul(0.76)));
  const physicalDaylight = nodes.celestialDaylight.max(0).min(1);
  const shadow = float(1).sub(stormCore.mul(0.36).mul(float(1).sub(facing)));
  const bodyLight = primaryFace.mul(0.52)
    .add(secondaryFace.mul(0.37))
    .add(tertiaryFace.mul(0.28))
    .add(physicalDaylight.mul(0.15))
    .mul(shadow);
  material.colorNode = vec3(bodyLight)
    .add(nodes.primaryStarColor.rgb.mul(primaryFace.mul(0.39).add(silver.mul(0.34))))
    .add(nodes.secondaryStarColor.rgb.mul(secondaryFace.mul(0.29)))
    .add(nodes.tertiaryStarColor.rgb.mul(tertiaryFace.mul(0.2)))
    .add(nodes.horizonColor.mul(rim.mul(0.12).add(stormCore.mul(0.048))))
    .add(nodes.twilightColor.mul(rim).mul(stormCore).mul(0.075));
  material.opacityNode = nodes.layerOpacity
    .mul(nodes.presentationOpacity)
    .mul(frontCoverage)
    .mul(sharedDensity.mul(0.63).add(0.35))
    .mul(facing.mul(0.68).add(rim.mul(0.19)).add(0.16))
    .mul(physicalDaylight.mul(0.62)
      .add(primaryVisibility.mul(0.28))
      .add(secondaryVisibility.mul(0.17))
      .add(0.085).min(1))
    .min(layer === 'core' ? 0.32 : 0.21);
  tagCelestialMaterial(material, celestial);
  material.userData.sharedPlanetWeather = true;
  material.userData.sharedWeatherDensity = true;
  material.userData.sharedWeatherNodeBridge = true;
  material.userData.actualStormCoverage = true;
  material.userData.bodyFixedWeatherDensity = true;
  material.userData.weatherFieldBodyId = weatherField.bodyId;
  material.userData.spectralCloudSilverlining = true;
  material.userData.orbitalWeatherLayer = layer;
  material.userData.cloudType = weatherField.cloudType;
  material.userData.cloudOpacityScale = weatherField.cloudOpacityScale;
  return material;
}

function createClouds(
  planet: PlanetDescriptor,
  field: PlanetField,
  radius: number,
  celestial: CelestialNodeLighting,
  weatherField?: PlanetWeatherField,
  weatherNodes?: PlanetWeatherNodes,
): THREE.Group {
  const random = new SeededRandom(planet.seed ^ 0xa117c10d);
  const clouds = new THREE.Group();
  clouds.name = `${planet.name} / planet-anchored clouds`;
  const samples: CloudWeatherSample[] = [];
  clouds.userData.weatherSamples = samples;
  const cloudField = weatherField ?? createPlanetWeather(planet, field);
  const cloudOpacityScale = cloudField.cloudOpacityScale;
  const appearance = planetCloudAppearance(cloudField.cloudType);
  clouds.userData.cloudType = cloudField.cloudType;
  clouds.userData.cloudOpacityScale = cloudOpacityScale;
  const count = supportsAtmosphericClouds(planet.atmosphere) && cloudField.supported
    ? Math.min(68, Math.round(20 + planet.atmosphere.cloudCoverage * 52))
    : 0;
  clouds.userData.instanceCount = count;
  if (count === 0) return clouds;

  const geometry = new THREE.IcosahedronGeometry(radius * 0.0105, 0);
  const sharedWeather = Boolean(weatherField && weatherNodes);
  // Atmospheric water is a translucent pale scattering layer, not unlit rock.
  // A Basic material avoids directional-shadow blotches on the actual planet.
  const legacyCoreMaterial = () => new THREE.MeshBasicMaterial({
    color: '#FFFFFF',
    transparent: true,
    opacity: CLOUD_CORE_OPACITY * cloudOpacityScale,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const cloudCore = new THREE.InstancedMesh(
    geometry,
    weatherField && weatherNodes
      ? createSharedOrbitalCloudMaterial(planet, celestial, weatherField, weatherNodes, 'core')
      : legacyCoreMaterial(),
    count,
  );
  cloudCore.name = 'Shared-weather faceted cloud bodies';
  cloudCore.frustumCulled = false;
  cloudCore.userData.brightScatteringOnly = true;
  cloudCore.userData.sharedPlanetWeather = sharedWeather;
  cloudCore.userData.actualStormCoverage = sharedWeather;

  const legacyWispMaterial = () => new THREE.MeshBasicMaterial({
    color: '#FFFFFF',
    transparent: true,
    opacity: CLOUD_WISP_OPACITY * cloudOpacityScale,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  const wisp = new THREE.InstancedMesh(
    geometry,
    weatherField && weatherNodes
      ? createSharedOrbitalCloudMaterial(planet, celestial, weatherField, weatherNodes, 'wisp')
      : legacyWispMaterial(),
    count,
  );
  wisp.name = 'Shared-weather upper ice wisps';
  wisp.frustumCulled = false;
  wisp.userData.brightScatteringOnly = true;
  wisp.userData.sharedPlanetWeather = sharedWeather;
  wisp.userData.actualStormCoverage = sharedWeather;

  const transform = new THREE.Object3D();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color(appearance.tint);
  const lavender = new THREE.Color('#D2C0F8').lerp(tint, appearance.tintStrength);
  const dusk = new THREE.Color('#EDB9E8').lerp(tint, appearance.tintStrength);
  const glacial = new THREE.Color('#C0F2EE').lerp(tint, appearance.tintStrength);
  let activeCount = 0;

  for (let index = 0; index < count; index += 1) {
    let weatherClimate: PlanetWeatherSample | undefined;
    let candidateSurface: PlanetSurfaceSample | undefined;
    for (let candidate = 0; candidate < 8; candidate += 1) {
      const theta = random.range(-Math.PI, Math.PI);
      const y = random.range(-0.83, 0.83);
      const radial = Math.sqrt(1 - y * y);
      normal.set(Math.cos(theta) * radial, y, Math.sin(theta) * radial);
      // Standalone callers use the same physical layer as the product path;
      // a legacy material must not put clouds at a fraction of planet radius.
      weatherClimate = cloudField.sample(normal, 0);
      candidateSurface = samplePlanetField(field, normal);
      const minimumLayer = weatherSurfaceHeightMeters(candidateSurface) + PLANET_CLOUD_TERRAIN_CLEARANCE_METERS + 360;
      if (minimumLayer < weatherClimate.cloudTopMeters &&
        (weatherClimate.density > 0.16 || candidate === 7)) break;
    }
    if (!weatherClimate) continue;
    const weather = candidateSurface ?? samplePlanetField(field, normal);
    const humidity = THREE.MathUtils.clamp(weatherClimate.humidity, 0, 1);
    const stormIntensity = weatherClimate.stormIntensity;
    const physicalThickness = THREE.MathUtils.clamp(
      (weatherClimate.cloudTopMeters - weatherClimate.cloudBaseMeters) *
        (0.09 + stormIntensity * 0.17) * appearance.verticalScale,
      180 * appearance.verticalScale,
      1_350,
    );
    const availableBottom = Math.max(weatherClimate.cloudBaseMeters,
      weatherSurfaceHeightMeters(weather) + PLANET_CLOUD_TERRAIN_CLEARANCE_METERS);
    const minimumAltitude = availableBottom + physicalThickness;
    const maximumAltitude = weatherClimate.cloudTopMeters - physicalThickness;
    if (minimumAltitude > maximumAltitude) continue;
    const weatherAltitudeMeters = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(weatherClimate.cloudBaseMeters, weatherClimate.cloudTopMeters,
        0.36 + stormIntensity * 0.28 + random.range(0, 0.17)),
      minimumAltitude,
      maximumAltitude,
    );
    const distance = radius * (1 + weatherAltitudeMeters / planet.radiusMeters);
    const cloudSample: CloudWeatherSample = {
      direction: { x: normal.x, y: normal.y, z: normal.z },
      moisture: weather.moisture,
      continentalness: weather.continentalness,
      radius: distance,
      cloudDensity: weatherClimate.density,
      stormIntensity,
      cloudBaseMeters: weatherClimate.cloudBaseMeters,
      cloudTopMeters: weatherClimate.cloudTopMeters,
      terrainHeightMeters: weatherSurfaceHeightMeters(weather),
      verticalRadiusMeters: physicalThickness,
    };
    samples.push(cloudSample);

    transform.position.copy(normal).multiplyScalar(distance);
    transform.quaternion.setFromUnitVectors(up, normal);
    transform.rotateY(random.range(-Math.PI, Math.PI));
    transform.scale.set(
      random.range(3.4, 7.2) * (0.72 + humidity * 0.43 + stormIntensity * 0.2),
      physicalThickness / (planet.radiusMeters * 0.0105),
      random.range(1.1, 2.8) * (0.77 + humidity * 0.3 + stormIntensity * 0.29),
    );
    transform.updateMatrix();
    cloudCore.setMatrixAt(activeCount, transform.matrix);
    const cloudColor = lavender.clone()
      .lerp(index % 4 === 0 ? dusk : glacial, humidity * 0.47)
      .lerp(new THREE.Color('#DDE9FF'), stormIntensity * 0.23);
    cloudCore.setColorAt(activeCount, cloudColor);

    // Upper wisps share the same physical envelope. A fixed upward offset can
    // otherwise escape a shallow atmosphere even when its core fits correctly.
    const wispHeight = physicalThickness * 0.54;
    const wispAltitude = THREE.MathUtils.clamp(
      weatherAltitudeMeters + Math.min(360,
        (weatherClimate.cloudTopMeters - weatherClimate.cloudBaseMeters) * 0.16),
      availableBottom + wispHeight,
      weatherClimate.cloudTopMeters - wispHeight,
    );
    cloudSample.wispAltitudeMeters = wispAltitude;
    cloudSample.wispVerticalRadiusMeters = wispHeight;
    transform.position.copy(normal).multiplyScalar(radius * (1 + wispAltitude / planet.radiusMeters));
    transform.scale.x *= 1.38;
    transform.scale.y *= 0.54;
    transform.scale.z *= 0.84;
    transform.updateMatrix();
    wisp.setMatrixAt(activeCount, transform.matrix);
    wisp.setColorAt(activeCount, glacial.clone().lerp(dusk, index % 5 === 0 ? 0.33 : 0.08));
    activeCount += 1;
  }

  cloudCore.count = activeCount;
  wisp.count = activeCount;
  clouds.userData.instanceCount = activeCount;
  cloudCore.instanceMatrix.needsUpdate = true;
  wisp.instanceMatrix.needsUpdate = true;
  if (cloudCore.instanceColor) cloudCore.instanceColor.needsUpdate = true;
  if (wisp.instanceColor) wisp.instanceColor.needsUpdate = true;
  clouds.add(cloudCore, wisp);
  clouds.userData.additiveScattering = true;
  clouds.userData.sharedPlanetWeather = sharedWeather;
  clouds.userData.sharedWeatherNodeBridge = sharedWeather;
  clouds.userData.actualStormCoverage = sharedWeather;
  return clouds;
}

function createRings(
  planet: PlanetDescriptor,
  radius: number,
  celestial: CelestialNodeLighting,
  secondaryStrength: { value: number },
): THREE.Group | undefined {
  if (!planet.ring) return undefined;

  const rings = new THREE.Group();
  rings.name = `${planet.name} / magenta orbital rings`;
  const inner = radius * (planet.ring.innerRadiusMeters / planet.radiusMeters);
  const outer = radius * (planet.ring.outerRadiusMeters / planet.radiusMeters);
  const base = new THREE.Color(planet.ring.color);
  const accent = base.clone().lerp(new THREE.Color('#FF12C7'), 0.82);
  const highlight = base.clone().lerp(new THREE.Color('#FF4ADD'), 0.74);
  const shadow = base.clone().lerp(new THREE.Color('#38116E'), 0.64);
  const nodes = {
    innerRadius: uniform(inner),
    outerRadius: uniform(outer),
    bodyRadius: uniform(radius),
    baseColor: uniform(base),
    accentColor: uniform(accent),
    highlightColor: uniform(highlight),
    shadowColor: uniform(shadow),
    ringOpacity: uniform(planet.ring.opacity),
    surfacePresentation: uniform(0),
    ...celestialUniforms(celestial),
    secondaryStrength: uniform(secondaryStrength.value),
    phase: uniform((planet.seed & 1023) / 1023 * Math.PI * 2),
    time: uniform(0),
  };
  const material = createEffectMaterial(nodes, {
    transparent: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  tagCelestialMaterial(material, celestial);
  material.fragmentNode = Fn(() => {
    // Clip only the segment geometrically behind this actual planet. Node
    // pipeline depth remains backend-owned for both WebGPU and WebGL fallback.
    const center = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const eyeToFragment = positionWorld.sub(cameraPosition);
    const fragmentDistance = eyeToFragment.length();
    const sight = eyeToFragment.div(fragmentDistance.max(0.00001));
    const eyeToCenter = center.sub(cameraPosition);
    const centerDistance = eyeToCenter.dot(sight);
    const nearestSquared = eyeToCenter.dot(eyeToCenter).sub(centerDistance.pow(2));
    const sphereSquared = nodes.bodyRadius.pow(2);
    const visibleSurface = centerDistance.sub(sphereSquared.sub(nearestSquared).max(0).sqrt());
    centerDistance.greaterThan(0).and(nearestSquared.lessThan(sphereSquared))
      .and(visibleSurface.greaterThan(0))
      .and(visibleSurface.lessThan(fragmentDistance.sub(0.0002)))
      .discard();

    const radial = positionLocal.xy.length();
    const progress = radial.sub(nodes.innerRadius)
      .div(nodes.outerRadius.sub(nodes.innerRadius)).clamp(0, 1);
    const bandA = progress.sub(0.15).div(0.047).pow(2).negate().exp();
    const bandB = progress.sub(0.34).div(0.064).pow(2).negate().exp();
    const bandC = progress.sub(0.63).div(0.05).pow(2).negate().exp();
    const bandD = progress.sub(0.83).div(0.023).pow(2).negate().exp();
    const bandE = progress.sub(0.49).div(0.018).pow(2).negate().exp();
    const filament = progress.mul(131).add(nodes.phase).sin().max(0).pow(9);
    const fineDust = progress.mul(47).sub(nodes.phase.mul(0.4)).sin().max(0).pow(3).mul(0.056);
    const crystalThreads = progress.mul(211).add(nodes.phase.mul(0.7)).sin().max(0).pow(15);
    const orbitalSheen = positionLocal.x.div(radial.max(0.00001)).mul(3)
      .add(nodes.phase).add(nodes.time.mul(0.025)).sin().mul(0.055).add(0.91);
    const density = bandA.mul(0.78).add(bandB.mul(1.24)).add(bandC.mul(0.84))
      .add(bandD.mul(1.1)).add(bandE.mul(0.7)).add(filament.mul(0.13))
      .add(crystalThreads.mul(0.085)).add(fineDust).add(0.014).mul(orbitalSheen);
    const edges = progress.smoothstep(0, 0.035).mul(float(1).sub(progress.smoothstep(0.93, 1)));
    const incidence = cameraPosition.sub(positionWorld).normalize().dot(normalWorld.normalize()).abs();
    const grazing = incidence.smoothstep(0.012, 0.24).mul(0.43).add(0.57);
    const baseTint = mix(nodes.shadowColor, nodes.baseColor,
      bandA.mul(0.71).add(bandC.mul(0.84)).add(0.27).min(1));
    const accentTint = mix(baseTint, nodes.accentColor, bandB.mul(0.86).add(bandE.mul(0.33)).min(1));
    const starToDust = positionWorld.sub(center);
    const primaryVisibility = nodes.primaryIrradiance.max(0).min(3.2)
      .mul(nodes.primaryHorizonVisibility)
      .mul(nodes.primaryTransmittance)
      .mul(nodes.primaryEclipseVisibility);
    const secondaryVisibility = nodes.secondaryIrradiance.max(0).min(3.2)
      .mul(nodes.secondaryHorizonVisibility)
      .mul(nodes.secondaryTransmittance)
      .mul(nodes.secondaryEclipseVisibility)
      .mul(nodes.secondaryStrength);
    const tertiaryVisibility = nodes.tertiaryIrradiance.max(0).min(3.2)
      .mul(nodes.tertiaryHorizonVisibility)
      .mul(nodes.tertiaryTransmittance)
      .mul(nodes.tertiaryEclipseVisibility);
    const primaryAxis = starToDust.dot(nodes.primaryLightDirection.normalize());
    const primaryOffset = starToDust.dot(starToDust).sub(primaryAxis.pow(2)).max(0).sqrt();
    const primaryShadow = primaryAxis.lessThan(0).select(
      primaryOffset.smoothstep(nodes.bodyRadius.mul(0.87), nodes.bodyRadius.mul(1.075)),
      float(1),
    ).mul(primaryVisibility);
    const secondaryAxis = starToDust.dot(nodes.secondaryLightDirection.normalize());
    const secondaryOffset = starToDust.dot(starToDust).sub(secondaryAxis.pow(2)).max(0).sqrt();
    const secondaryShadow = secondaryAxis.lessThan(0).select(
      secondaryOffset.smoothstep(nodes.bodyRadius.mul(0.87), nodes.bodyRadius.mul(1.075)),
      float(1),
    ).mul(secondaryVisibility);
    const tertiaryAxis = starToDust.dot(nodes.tertiaryLightDirection.normalize());
    const tertiaryOffset = starToDust.dot(starToDust).sub(tertiaryAxis.pow(2)).max(0).sqrt();
    const tertiaryShadow = tertiaryAxis.lessThan(0).select(
      tertiaryOffset.smoothstep(nodes.bodyRadius.mul(0.87), nodes.bodyRadius.mul(1.075)),
      float(1),
    ).mul(tertiaryVisibility);
    const binaryIllumination = primaryShadow.mul(0.65)
      .add(secondaryShadow.mul(0.29))
      .add(tertiaryShadow.mul(0.21))
      .add(nodes.celestialDaylight.mul(0.1).add(0.14));
    const primarySpectral = nodes.primaryStarColor.rgb.mul(
      nodes.primaryTransmissionColor.rgb.div(nodes.primaryTransmittance.max(0.0001)),
    );
    const secondarySpectral = nodes.secondaryStarColor.rgb.mul(
      nodes.secondaryTransmissionColor.rgb.div(nodes.secondaryTransmittance.max(0.0001)),
    );
    const tertiarySpectral = nodes.tertiaryStarColor.rgb.mul(
      nodes.tertiaryTransmissionColor.rgb.div(nodes.tertiaryTransmittance.max(0.0001)),
    );
    const color = mix(accentTint, nodes.highlightColor,
      bandD.mul(0.62).add(filament.mul(0.17)).add(crystalThreads.mul(0.16)).min(0.77))
      .mul(bandB.mul(0.39).add(bandD.mul(0.25)).add(0.82))
      .mul(binaryIllumination)
      .add(primarySpectral.mul(primaryShadow).mul(crystalThreads).mul(0.052))
      .add(secondarySpectral.mul(secondaryShadow).mul(filament).mul(0.036))
      .add(tertiarySpectral.mul(tertiaryShadow).mul(filament).mul(0.028));
    const surfaceFill = mix(float(1), float(0.1), nodes.surfacePresentation);
    const surfaceFilament = filament.mul(0.62).add(bandD.mul(0.38)).add(bandE.mul(0.17)).min(1);
    const presentation = mix(surfaceFill, mix(float(1), float(0.36), nodes.surfacePresentation), surfaceFilament);
    const alpha = density.mul(nodes.ringOpacity).mul(1.31).min(0.89)
      .mul(edges).mul(grazing).mul(presentation);
    alpha.lessThan(0.009).discard();
    return vec4(color, alpha);
  })();
  material.userData.bandCenters = [0.15, 0.34, 0.49, 0.63, 0.83];
  material.userData.crystalThreads = true;
  material.userData.physicalBodyOcclusion = true;
  material.userData.surfaceFill = 0.1;
  material.userData.surfaceFilamentFill = 0.36;
  material.userData.actualBinaryStarLighting = true;
  material.userData.actualTripleStarLighting = true;
  material.userData.eclipseAwareRingLighting = true;
  material.userData.physicalPlanetaryRingShadow = true;
  const annulus = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 160, 8), material);
  annulus.name = 'Procedural seeded multiband ring annulus';
  annulus.rotation.x = -Math.PI / 2;
  rings.add(annulus);

  for (const [fraction, color, opacity] of [
    [0.34, 0xff25cd, 0.95],
    [0.83, 0xff59df, 0.72],
  ] as const) {
    const ringRadius = THREE.MathUtils.lerp(inner, outer, fraction);
    const points: number[] = [];
    for (let index = 0; index < 192; index += 1) {
      const angle = index / 192 * Math.PI * 2;
      const nextAngle = (index + 1) / 192 * Math.PI * 2;
      points.push(
        Math.cos(angle) * ringRadius, 0, Math.sin(angle) * ringRadius,
        Math.cos(nextAngle) * ringRadius, 0, Math.sin(nextAngle) * ringRadius,
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    // GameApp centrally disposes Mesh, Points, and LineSegments. Explicit
    // segments keep ring resources bounded across actual interstellar jumps.
    const contour = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: opacity * THREE.MathUtils.clamp(planet.ring.opacity + 0.3, 0, 1),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));
    contour.name = 'Actual ring-plane luminous density contour';
    rings.add(contour);
  }

  // One real annular population, never a sky sprite or additional star. Its
  // instancing, instance colors, and logarithmic depth stay node-pipeline owned.
  const debrisNodes = {
    ...celestialUniforms(celestial),
    secondaryStrength: uniform(secondaryStrength.value),
    surfacePresentation: uniform(0),
  };
  const debrisMaterial = createEffectMaterial(debrisNodes, {
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  tagCelestialMaterial(debrisMaterial, celestial);
  const shardNormal = normalWorld.normalize();
  const primaryVisible = debrisNodes.primaryIrradiance.max(0).min(3.2)
    .mul(debrisNodes.primaryHorizonVisibility)
    .mul(debrisNodes.primaryTransmittance)
    .mul(debrisNodes.primaryEclipseVisibility);
  const secondaryVisible = debrisNodes.secondaryIrradiance.max(0).min(3.2)
    .mul(debrisNodes.secondaryHorizonVisibility)
    .mul(debrisNodes.secondaryTransmittance)
    .mul(debrisNodes.secondaryEclipseVisibility)
    .mul(debrisNodes.secondaryStrength);
  const tertiaryVisible = debrisNodes.tertiaryIrradiance.max(0).min(3.2)
    .mul(debrisNodes.tertiaryHorizonVisibility)
    .mul(debrisNodes.tertiaryTransmittance)
    .mul(debrisNodes.tertiaryEclipseVisibility);
  const primaryFacet = shardNormal.dot(debrisNodes.primaryLightDirection.normalize())
    .mul(0.5).add(0.5).max(0).mul(primaryVisible);
  const secondaryFacet = shardNormal.dot(debrisNodes.secondaryLightDirection.normalize())
    .mul(0.5).add(0.5).max(0).mul(secondaryVisible);
  const tertiaryFacet = shardNormal.dot(debrisNodes.tertiaryLightDirection.normalize())
    .mul(0.5).add(0.5).max(0).mul(tertiaryVisible);
  const primarySpectral = debrisNodes.primaryStarColor.rgb.mul(
    debrisNodes.primaryTransmissionColor.rgb.div(debrisNodes.primaryTransmittance.max(0.0001)),
  );
  const secondarySpectral = debrisNodes.secondaryStarColor.rgb.mul(
    debrisNodes.secondaryTransmissionColor.rgb.div(debrisNodes.secondaryTransmittance.max(0.0001)),
  );
  const tertiarySpectral = debrisNodes.tertiaryStarColor.rgb.mul(
    debrisNodes.tertiaryTransmissionColor.rgb.div(debrisNodes.tertiaryTransmittance.max(0.0001)),
  );
  debrisMaterial.colorNode = primarySpectral
    .mul(primaryFacet.mul(0.19).add(primaryVisible.mul(0.06)))
    .add(secondarySpectral.mul(secondaryFacet).mul(0.15))
    .add(tertiarySpectral.mul(tertiaryFacet).mul(0.11))
    .add(vec3(0.12, 0.045, 0.17).mul(debrisNodes.celestialDaylight.mul(0.47).add(0.42)));
  debrisMaterial.opacityNode = primaryFacet.mul(0.27)
    .add(secondaryFacet.mul(0.13))
    .add(tertiaryFacet.mul(0.095))
    .add(debrisNodes.celestialDaylight.mul(0.095).add(0.065))
    .mul(float(1).sub(debrisNodes.surfacePresentation.mul(0.59)))
    .min(0.49);
  debrisMaterial.userData.physicalBinaryStarScattering = true;
  debrisMaterial.userData.physicalTripleStarScattering = true;
  debrisMaterial.userData.bodyFixedRingDebris = true;
  const debris = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(radius * 0.00145, 0),
    debrisMaterial,
    72,
  );
  debris.name = 'Actual ring-plane icy debris';
  debris.frustumCulled = false;
  const random = new SeededRandom(planet.seed ^ 0x43e91bd);
  const shard = new THREE.Object3D();
  for (let index = 0; index < debris.count; index += 1) {
    const angle = random.range(0, Math.PI * 2);
    const annularRadius = THREE.MathUtils.lerp(inner, outer, random.range(0.038, 0.957));
    shard.position.set(
      Math.cos(angle) * annularRadius,
      random.range(-radius * 0.00047, radius * 0.00047),
      Math.sin(angle) * annularRadius,
    );
    shard.rotation.set(random.range(0, Math.PI), random.range(0, Math.PI), random.range(0, Math.PI));
    shard.scale.set(random.range(0.64, 1.65), random.range(0.39, 0.95), random.range(0.54, 1.48));
    shard.updateMatrix();
    debris.setMatrixAt(index, shard.matrix);
    debris.setColorAt(index, base.clone().lerp(
      random.chance(0.18) ? new THREE.Color('#BCEAF0') : highlight,
      random.range(0.17, 0.71),
    ));
  }
  debris.instanceMatrix.needsUpdate = true;
  if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
  debris.userData.bodyId = planet.id;
  debris.userData.bodyFixed = true;
  debris.userData.actualAnnulus = true;
  debris.userData.physicalInnerRadius = inner;
  debris.userData.physicalOuterRadius = outer;
  debris.userData.angularVelocityRadiansPerSecond = Math.sqrt(
    GRAVITATIONAL_CONSTANT * planet.massKg /
      Math.pow((planet.ring.innerRadiusMeters + planet.ring.outerRadiusMeters) * 0.5, 3),
  );
  debris.userData.instanceCount = debris.count;
  rings.add(debris);

  rings.rotation.z = planet.ring.tiltRadians;
  rings.renderOrder = 2;
  rings.userData.innerRadius = inner;
  rings.userData.outerRadius = outer;
  rings.userData.physicalBandCount = 5;
  rings.userData.hotMagentaBands = true;
  rings.userData.surfaceVisibleRingArc = true;
  rings.userData.sharpCrystallineDensityThreads = true;
  rings.userData.physicalBinaryStarLighting = true;
  rings.userData.physicalTripleStarLighting = true;
  rings.userData.physicalCelestialLighting = true;
  rings.userData.bodyFixedAnnularDebrisCount = debris.count;
  return rings;
}

export function createPlanetEffects(
  planet: PlanetDescriptor,
  radius: number,
  options: PlanetEffectsOptions = {},
): PlanetEffects {
  const primary = new THREE.Vector3(0.58, 0.35, 0.72).normalize();
  const secondary = new THREE.Vector3(-0.41, 0.28, 0.82).normalize();
  const secondaryStrength = { value: 0 };
  const primaryStarColor = new THREE.Color('#FFD986');
  const secondaryStarColor = new THREE.Color('#FF8C78');
  const celestial = createCelestialNodeLighting(undefined, {
    directions: [primary, secondary],
    colors: [primaryStarColor, secondaryStarColor],
    secondaryStrength: secondaryStrength.value,
  });
  const field = options.field ?? createPlanetField(planet);
  const hasPhysicalWater = planet.archetype === 'ocean' || planet.archetype === 'temperate';
  const atmosphere = createAtmosphere(
    planet,
    radius,
    celestial,
    secondaryStrength,
  );
  const skyGlow = createTwilightSky(
    planet,
    radius,
    celestial,
    secondaryStrength,
  );
  const ocean = createOcean(
    planet,
    field,
    radius,
    celestial,
    secondaryStrength,
    options.oceanSubdivisions,
    options.proxyGeometry,
    options.oceanDepth,
  );
  const oceanCoverage = createSurfacePatchCoverageSetMask();
  const oceanMaterial = ocean.material as PlanetNodeMaterial;
  oceanMaterial.maskNode = oceanCoverage.node;
  let ownedOceanGeometry = ocean.geometry === options.proxyGeometry ? undefined : ocean.geometry;
  let outgoingOcean: THREE.Mesh<THREE.BufferGeometry, PlanetNodeMaterial> | undefined;
  let incomingOceanMask: Node<'bool'> | undefined;
  let outgoingOceanMask: Node<'bool'> | undefined;
  const updateOceanGeometryMetadata = (geometry: THREE.BufferGeometry): void => {
    ocean.userData.sharedProxyGeometry = true;
    ocean.userData.sharedFieldSamples = Number(geometry.userData.sharedFieldSamples ?? 0);
    ocean.userData.sharedFieldWetVertices = Number(geometry.userData.sharedFieldWetVertices ?? 0);
    ocean.userData.subdivision = Number(geometry.userData.proxySubdivisions ?? 1) - 1;
    ocean.userData.triangleCount = geometry.getAttribute('position')?.count / 3 || 0;
  };
  const clouds = createClouds(
    planet,
    field,
    radius,
    celestial,
    options.weatherField,
    options.weatherNodes,
  );
  const localWeather = new AtmosphericWeather(planet, field, radius, {
    primary,
    secondary,
    primaryColor: primaryStarColor,
    secondaryColor: secondaryStarColor,
    secondaryStrength,
    celestial,
  }, {
    weatherField: options.weatherField,
    weatherNodes: options.weatherNodes,
  });
  clouds.add(localWeather.group);
  clouds.userData.localWeather = localWeather.state;
  clouds.userData.bodyId = planet.id;
  clouds.userData.windSpeedMetersPerSecond = localWeather.state.windSpeedMetersPerSecond;
  clouds.userData.physicalWindAngularVelocityRadiansPerSecond =
    localWeather.windAngularVelocityRadiansPerSecond;
  clouds.userData.sharedPlanetWeather = Boolean(options.weatherField);
  clouds.userData.sharedWeatherNodeBridge = Boolean(options.weatherNodes);
  clouds.userData.weatherFieldBodyId = options.weatherField?.bodyId;
  clouds.userData.weatherFieldSeed = options.weatherField?.seed;
  clouds.userData.actualStormCoverage = Boolean(options.weatherField);
  if (options.weatherField) {
    clouds.userData.weatherAtlasWidth = options.weatherField.atlas.width;
    clouds.userData.weatherAtlasHeight = options.weatherField.atlas.height;
    clouds.userData.weatherFrame = 'body-fixed';
  }
  const rings = createRings(
    planet,
    radius,
    celestial,
    secondaryStrength,
  );
  const hasAtmosphere = hasRenderableAtmosphere(planet.atmosphere);
  const hasClouds = localWeather.state.supported;
  const cloudOpacityScale = hasClouds
    ? options.weatherField?.cloudOpacityScale ?? planet.atmosphere.cloudOpacityScale
    : 0;
  let presentationInterior = 0;
  let orbitalCloudVisibility = 1;
  const orbitalCore = clouds.children.find((child) => child.name === 'Shared-weather faceted cloud bodies') as
    THREE.InstancedMesh | undefined;
  const orbitalWisp = clouds.children.find((child) => child.name === 'Shared-weather upper ice wisps') as
    THREE.InstancedMesh | undefined;
  const refreshCloudPresentation = () => {
    const exterior = (1 - presentationInterior) * orbitalCloudVisibility;
    clouds.userData.orbitalVisibility = orbitalCloudVisibility;
    clouds.userData.orbitalPresentationOpacity = exterior;
    clouds.visible = hasClouds && (exterior > 0.000_01 || localWeather.group.visible);
    for (const [mesh, baseOpacity] of [
      [orbitalCore, options.weatherNodes ? SHARED_ORBITAL_CORE_OPACITY : CLOUD_CORE_OPACITY],
      [orbitalWisp, options.weatherNodes ? SHARED_ORBITAL_WISP_OPACITY : CLOUD_WISP_OPACITY],
    ] as const) {
      if (!mesh) continue;
      mesh.visible = exterior > 0.000_01;
      const material = mesh.material as THREE.MeshBasicMaterial | PlanetNodeMaterial;
      material.opacity = baseOpacity * exterior * cloudOpacityScale;
      if ('uniforms' in material && material.uniforms.presentationOpacity) {
        material.uniforms.presentationOpacity.value = exterior;
      }
    }
  };

  return {
    atmosphere,
    skyGlow,
    clouds,
    ocean,
    rings,
    weather: localWeather.state,
    update(elapsed) {
      clouds.rotation.y = elapsed * localWeather.windAngularVelocityRadiansPerSecond *
        (options.weatherField ? -1 : 1);
      localWeather.update(elapsed);
      clouds.userData.stormIntensity = localWeather.state.stormIntensity;
      clouds.userData.cloudCoverage = localWeather.state.cloudCoverage;
      clouds.userData.weatherFieldDensity = localWeather.state.weatherFieldDensity;
      clouds.userData.weatherEpochSeconds = elapsed;
      (ocean.material as PlanetNodeMaterial).uniforms.time!.value = elapsed;
      if (rings) {
        ((rings.children[0] as THREE.Mesh).material as PlanetNodeMaterial).uniforms.time!.value = elapsed;
        const debris = rings.getObjectByName('Actual ring-plane icy debris');
        if (debris) {
          debris.rotation.y = elapsed * (debris.userData.angularVelocityRadiansPerSecond as number);
        }
      }
      // Water coverage is sampled from the exact body-fixed terrain field. Only
      // the analytic ripple phase advances; the sea itself must not rotate away.
      ocean.rotation.y = 0;
    },
    setObserver(bodyFixedDirection, altitudeMeters, elapsedSeconds = 0) {
      const state = localWeather.setObserver(bodyFixedDirection, altitudeMeters, elapsedSeconds);
      for (const material of [atmosphere.material, skyGlow.material] as PlanetNodeMaterial[]) {
        material.uniforms.observerDensity!.value = state.atmosphericDensity;
        material.uniforms.cloudDensity!.value = state.cloudDensity;
        material.uniforms.observerAltitudeRatio!.value = hasAtmosphere
          ? THREE.MathUtils.clamp(state.observerAltitudeMeters / planet.atmosphere.heightMeters, 0, 1)
          : 1;
        material.uniforms.aerialPerspective!.value = state.opticalDepth;
        material.uniforms.observerClearance!.value = Number.isFinite(state.surfaceClearanceMeters)
          ? state.surfaceClearanceMeters
          : 0;
        material.uniforms.weatherHumidity!.value = state.localMoisture;
      }
      refreshCloudPresentation();
      return state;
    },
    setStarDirections(primaryWorld, secondaryWorld, primaryColor, secondaryColor) {
      if (primaryWorld.lengthSq() > 0) primary.copy(primaryWorld).normalize();
      if (primaryColor !== undefined) primaryStarColor.set(primaryColor);
      if (secondaryWorld && secondaryWorld.lengthSq() > 0) {
        secondary.copy(secondaryWorld).normalize();
        secondaryStrength.value = 1;
        if (secondaryColor !== undefined) secondaryStarColor.set(secondaryColor);
        celestial.irradiance[1].value = 1;
        celestial.horizon[1].value = 1;
        celestial.transmittance[1].value = 1;
        celestial.transmissionColors[1].value.setRGB(1, 1, 1);
        celestial.eclipse[1].value = 1;
        celestial.activeCount.value = 2;
      } else {
        secondary.copy(primary);
        secondaryStrength.value = 0;
        celestial.irradiance[1].value = 0;
        celestial.horizon[1].value = 0;
        celestial.transmittance[1].value = 0;
        celestial.transmissionColors[1].value.setRGB(0, 0, 0);
        celestial.eclipse[1].value = 0;
        celestial.activeCount.value = 1;
      }
      for (const material of [atmosphere.material, skyGlow.material, ocean.material] as PlanetNodeMaterial[]) {
        material.uniforms.secondaryStrength!.value = secondaryStrength.value;
      }
      if (rings) {
        for (const child of rings.children) {
          if (!(child instanceof THREE.Mesh)) continue;
          const material = child.material as PlanetNodeMaterial;
          if (material.uniforms.secondaryStrength) {
            material.uniforms.secondaryStrength.value = secondaryStrength.value;
          }
        }
      }
    },
    setCelestialLighting(frame) {
      updateCelestialNodeLighting(celestial, frame);
      secondaryStrength.value = frame.sources[1].active ? 1 : 0;
      for (const material of [atmosphere.material, skyGlow.material, ocean.material] as PlanetNodeMaterial[]) {
        material.uniforms.secondaryStrength!.value = secondaryStrength.value;
      }
      if (rings) {
        for (const child of rings.children) {
          if (!(child instanceof THREE.Mesh)) continue;
          const material = child.material as PlanetNodeMaterial;
          if (material.uniforms.secondaryStrength) {
            material.uniforms.secondaryStrength.value = secondaryStrength.value;
          }
        }
      }
    },
    setTerrainTransition(transitionStrength) {
      const physical = hasAtmosphere && Number.isFinite(transitionStrength)
        ? THREE.MathUtils.clamp(transitionStrength, 0, 1)
        : 0;
      for (const material of [atmosphere.material, skyGlow.material] as PlanetNodeMaterial[]) {
        material.uniforms.terrainTransition!.value = physical;
      }
    },
    setSurfaceCutout(bodyFixedDirection, cosine) {
      const material = ocean.material as PlanetNodeMaterial;
      if (!Number.isFinite(cosine) || cosine >= 1 || bodyFixedDirection.lengthSq() === 0) {
        material.uniforms.surfaceCutoutCosine!.value = 2;
        return;
      }
      (material.uniforms.surfaceCutoutDirection!.value as THREE.Vector3)
        .copy(bodyFixedDirection).normalize();
      material.uniforms.surfaceCutoutCosine!.value = THREE.MathUtils.clamp(cosine, -1, 1);
    },
    setSurfaceCoverage(coverage) {
      oceanCoverage.set(coverage, {
        originBodyFixedMeters: { x: 0, y: 0, z: 0 },
        metersPerLocalUnit: planet.radiusMeters / radius,
      });
      ocean.userData.opaqueSurfaceCoverageCount = oceanCoverage.count;
    },
    setProxyGeometry(geometry) {
      if (!hasPhysicalWater || !geometry.hasAttribute('waterColor')) return;
      ocean.geometry = geometry;
      updateOceanGeometryMetadata(geometry);
      // Only the standalone fallback belongs to this effect. All subsequent
      // incoming/outgoing buffers are owned by the proxy LOD controller.
      ownedOceanGeometry?.dispose();
      ownedOceanGeometry = undefined;
    },
    setProxyTransition(transition) {
      if (!hasPhysicalWater) return;
      if (incomingOceanMask !== transition.incomingMask) {
        incomingOceanMask = transition.incomingMask;
        oceanMaterial.maskNode = oceanCoverage.node.and(incomingOceanMask);
        oceanMaterial.needsUpdate = true;
      }
      if (transition.outgoingGeometry) {
        if (!outgoingOcean) {
          const material = Object.assign(oceanMaterial.clone(), { uniforms: oceanMaterial.uniforms });
          outgoingOcean = new THREE.Mesh(transition.outgoingGeometry, material);
          outgoingOcean.name = `${planet.name} / outgoing ocean resolution`;
          outgoingOcean.userData.sharedProxyGeometry = true;
          ocean.add(outgoingOcean);
        }
        if (outgoingOceanMask !== transition.outgoingMask) {
          outgoingOceanMask = transition.outgoingMask;
          outgoingOcean.material.maskNode = oceanCoverage.node.and(outgoingOceanMask);
          outgoingOcean.material.needsUpdate = true;
        }
        outgoingOcean.geometry = transition.outgoingGeometry;
        outgoingOcean.visible = true;
      } else if (outgoingOcean) {
        outgoingOcean.visible = false;
        // Do not retain the array buffers the LOD controller just released.
        outgoingOcean.geometry = ocean.geometry;
      }
    },
    setPresentation(surfaceBlend) {
      const amount = THREE.MathUtils.clamp(surfaceBlend, 0, 1);
      const interior = amount * amount * (3 - 2 * amount);
      const exterior = 1 - interior;
      presentationInterior = interior;
      (atmosphere.material as PlanetNodeMaterial).uniforms.presentationOpacity!.value = exterior;
      (skyGlow.material as PlanetNodeMaterial).uniforms.presentationOpacity!.value = interior;
      if (rings) {
        ((rings.children[0] as THREE.Mesh).material as PlanetNodeMaterial)
          .uniforms.surfacePresentation!.value = interior;
        const debris = rings.getObjectByName('Actual ring-plane icy debris') as THREE.InstancedMesh | undefined;
        if (debris) {
          (debris.material as PlanetNodeMaterial).uniforms.surfacePresentation!.value = interior;
        }
      }
      atmosphere.visible = hasAtmosphere && exterior > 0.003;
      skyGlow.visible = hasAtmosphere && planet.isLandable && interior > 0.003;
      refreshCloudPresentation();
    },
    setOrbitalCloudVisibility(visibility) {
      orbitalCloudVisibility = Number.isFinite(visibility) ? THREE.MathUtils.clamp(visibility, 0, 1) : 0;
      refreshCloudPresentation();
    },
  };
}
