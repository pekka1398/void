import * as THREE from 'three/webgpu';
import { mix, texture as sampleTexture, uniform, uv, vec4 } from 'three/tsl';
import type { PlanetDescriptor } from '../../universe';

const TEXTURE_SIZE = 64;
const MIN_PLANET_DIAMETER = 10;
const MIN_MOON_DIAMETER = 7;
const MIN_SELECTED_DIAMETER = 14;
const PLANET_FADE_START = 9;
const PLANET_FADE_END = 25;
const SELECTED_FADE_START = 12;
const SELECTED_FADE_END = 32;
let sharedBeaconTexture: { texture: THREE.DataTexture; references: number } | undefined;

export interface PlanetVisibilityState {
  apparentDiameterPixels: number;
  beaconDiameterPixels: number;
  physicalBlend: number;
  opacity: number;
  worldDiameter: number;
  visible: boolean;
}

export interface PlanetVisibility {
  readonly object: THREE.Sprite;
  update: (
    camera: THREE.PerspectiveCamera,
    distanceRenderUnits: number,
    viewportHeight: number,
    selected?: boolean,
  ) => void;
  dispose: () => void;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const normalized = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

/**
 * An explicit navigation mark, not a second painting of the planet. Its
 * position/color identify a real body; its pixels make no claim about that
 * body's continents, cloud cover, ring projection, or stellar terminator.
 */
function createPlanetBeaconTexture(): THREE.DataTexture {
  const bytes = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const dx = (x + 0.5) / TEXTURE_SIZE * 2 - 1;
      const dy = (y + 0.5) / TEXTURE_SIZE * 2 - 1;
      const radius = Math.hypot(dx, dy);
      const core = 1 - smoothstep(0.08, 0.25, radius);
      const halo = (1 - smoothstep(0.1, 0.58, radius)) * 0.17;
      const ring = smoothstep(0.52, 0.59, radius) *
        (1 - smoothstep(0.65, 0.72, radius)) * 0.42;
      const verticalTick = Math.abs(dx) < 0.025 && Math.abs(dy) > 0.76 && Math.abs(dy) < 0.9;
      const horizontalTick = Math.abs(dy) < 0.025 && Math.abs(dx) > 0.76 && Math.abs(dx) < 0.9;
      const alpha = Math.max(core, halo, ring, verticalTick || horizontalTick ? 0.46 : 0);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      bytes[offset] = 255;
      bytes[offset + 1] = 255;
      bytes[offset + 2] = 255;
      bytes[offset + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(bytes, TEXTURE_SIZE, TEXTURE_SIZE);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function acquirePlanetBeaconTexture(): THREE.DataTexture {
  if (!sharedBeaconTexture) sharedBeaconTexture = { texture: createPlanetBeaconTexture(), references: 0 };
  sharedBeaconTexture.references += 1;
  return sharedBeaconTexture.texture;
}

function releasePlanetBeaconTexture(texture: THREE.DataTexture): void {
  if (!sharedBeaconTexture || sharedBeaconTexture.texture !== texture) return;
  sharedBeaconTexture.references -= 1;
  if (sharedBeaconTexture.references > 0) return;
  sharedBeaconTexture.texture.dispose();
  sharedBeaconTexture = undefined;
}

/** The apparent size follows the real body radius and its true camera distance. */
export function planetApparentDiameterPixels(
  physicalRenderRadius: number,
  distanceRenderUnits: number,
  viewportHeight: number,
  verticalFovDegrees: number,
): number {
  if (
    !Number.isFinite(physicalRenderRadius)
    || !Number.isFinite(distanceRenderUnits)
    || !Number.isFinite(viewportHeight)
    || !Number.isFinite(verticalFovDegrees)
    || physicalRenderRadius <= 0
    || distanceRenderUnits <= 0
    || viewportHeight <= 0
    || verticalFovDegrees <= 0
    || verticalFovDegrees >= 180
  ) return 0;

  const halfFov = THREE.MathUtils.degToRad(verticalFovDegrees) * 0.5;
  return physicalRenderRadius / distanceRenderUnits * viewportHeight / Math.tan(halfFov);
}

/**
 * A bounded visual floor keeps an actual remote body readable; no simulation
 * position, physical radius, orbital phase, or destination ID is modified.
 */
export function planetVisibilityState(
  physicalRenderRadius: number,
  distanceRenderUnits: number,
  viewportHeight: number,
  verticalFovDegrees: number,
  selected = false,
  moon = false,
): PlanetVisibilityState {
  const apparentDiameterPixels = planetApparentDiameterPixels(
    physicalRenderRadius,
    distanceRenderUnits,
    viewportHeight,
    verticalFovDegrees,
  );

  if (apparentDiameterPixels <= 0) {
    return {
      apparentDiameterPixels: 0,
      beaconDiameterPixels: 0,
      physicalBlend: 1,
      opacity: 0,
      worldDiameter: 0,
      visible: false,
    };
  }

  const minimumDiameter = selected ? MIN_SELECTED_DIAMETER : moon ? MIN_MOON_DIAMETER : MIN_PLANET_DIAMETER;
  const beaconDiameterPixels = Math.max(minimumDiameter, apparentDiameterPixels * 1.08);
  const physicalBlend = smoothstep(
    selected ? SELECTED_FADE_START : PLANET_FADE_START,
    selected ? SELECTED_FADE_END : PLANET_FADE_END,
    apparentDiameterPixels,
  );
  const opacity = (1 - physicalBlend) * (selected ? 0.96 : moon ? 0.79 : 0.88);
  const worldDiameter = beaconDiameterPixels * distanceRenderUnits
    * (2 * Math.tan(THREE.MathUtils.degToRad(verticalFovDegrees) * 0.5))
    / viewportHeight;

  return {
    apparentDiameterPixels,
    beaconDiameterPixels,
    physicalBlend,
    opacity,
    worldDiameter,
    visible: opacity > 0.003,
  };
}

/** One cheap camera-facing, log-depth-safe sprite anchored to one real catalog body. */
export function createPlanetVisibility(
  planet: PlanetDescriptor,
  physicalRenderRadius: number,
): PlanetVisibility {
  const texture = acquirePlanetBeaconTexture();
  const selectedStrength = uniform(0);
  const atmosphericColor = uniform(new THREE.Color(planet.colors.atmosphere));
  const beaconColor = uniform(new THREE.Color('#76D8EA').lerp(new THREE.Color(planet.colors.atmosphere), 0.28));
  const bodySample = sampleTexture(texture, uv());
  const material = new THREE.SpriteNodeMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    alphaTest: 0.012,
    depthTest: true,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  material.colorNode = vec4(bodySample.rgb.mul(mix(beaconColor, atmosphericColor,
    selectedStrength.mul(0.24))), bodySample.a);
  material.userData.bodyId = planet.id;
  material.userData.atmosphericColor = atmosphericColor;
  material.userData.selectedStrength = selectedStrength;
  const object = new THREE.Sprite(material);
  object.name = `${planet.name} / real body navigation beacon`;
  object.visible = false;
  object.renderOrder = 6;
  object.userData = {
    bodyId: planet.id,
    systemId: planet.systemId,
    catalogBacked: true,
    bodyAnchored: true,
    worldAnchored: true,
    physicalRenderRadius,
    generatorSeed: planet.seed,
    archetype: planet.archetype,
    ringed: Boolean(planet.ring),
    descriptorCloudCoverage: planet.atmosphere.cloudCoverage,
    descriptorAtmosphereDensity: planet.atmosphere.density,
    descriptorAtmosphereColor: planet.colors.atmosphere,
    descriptorRingColor: planet.ring?.color,
    descriptorTerminator: false,
    appearancePolicy: 'truthful-navigation-beacon',
    depictsSurfaceGeography: false,
    moon: Boolean(planet.parentPlanetId),
    apparentDiameterPixels: 0,
    beaconDiameterPixels: 0,
    physicalBlend: 1,
  };

  let disposed = false;

  return {
    object,
    update(camera, distanceRenderUnits, viewportHeight, selected = false) {
      if (disposed) return;
      const state = planetVisibilityState(
        physicalRenderRadius,
        distanceRenderUnits,
        viewportHeight,
        camera.getEffectiveFOV(),
        selected,
        Boolean(planet.parentPlanetId),
      );
      object.visible = state.visible;
      object.scale.setScalar(state.worldDiameter);
      material.opacity = state.opacity;
      selectedStrength.value = selected ? 1 : 0;
      object.userData.apparentDiameterPixels = state.apparentDiameterPixels;
      object.userData.beaconDiameterPixels = state.beaconDiameterPixels;
      object.userData.physicalBlend = state.physicalBlend;
      object.userData.selected = selected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.removeFromParent();
      releasePlanetBeaconTexture(texture);
      material.dispose();
    },
  };
}
