import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  float,
  instancedBufferAttribute,
  instancedDynamicBufferAttribute,
  mix,
  normalWorld,
  positionLocal,
  positionWorld,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import {
  cloneAddress,
  LIGHT_YEAR_METERS,
  SeededRandom,
  SOLAR_RADIUS_METERS,
  subtractAddresses,
} from '../../core';
import type { GalacticAddress } from '../../core';
import type { StarDescriptor, StarSystem } from '../../universe';
import { PALETTE } from '../style/Palette';
import type { SystemVisualTheme } from './SystemVisualTheme';

type SpaceSpriteKind = 'star' | 'nebula';

export interface NebulaLayerLayout {
  readonly count: number;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
}

interface NebulaLayerStyle {
  count: number;
  size: number;
  opacity: number;
  spread: number;
  brightness: number;
  radius: number;
}

const NEBULA_LAYERS: readonly NebulaLayerStyle[] = [
  // The diffuse hierarchy overlaps a real seeded gas seam instead of resolving
  // into disconnected circular bokeh. Empty sky outside the arm remains black.
  { count: 176, size: 132, opacity: 0.092, spread: 0.132, brightness: 0.46, radius: 8_620 },
  { count: 264, size: 91, opacity: 0.15, spread: 0.076, brightness: 0.62, radius: 8_360 },
  { count: 188, size: 58, opacity: 0.22, spread: 0.04, brightness: 0.79, radius: 8_090 },
  { count: 74, size: 29, opacity: 0.31, spread: 0.021, brightness: 0.96, radius: 7_890 },
];

const NEBULA_FORMATION_COLORS = [
  new THREE.Color('#19102F'),
  new THREE.Color('#342063'),
  new THREE.Color('#58318F'),
  new THREE.Color('#9439B1'),
  new THREE.Color('#D541A1'),
  new THREE.Color('#6E32BA'),
  new THREE.Color('#283D89'),
  new THREE.Color('#07577B'),
  new THREE.Color('#08A8B2'),
  new THREE.Color('#5E2492'),
  new THREE.Color('#A8409B'),
  new THREE.Color('#D98762'),
] as const;

interface NebulaFormationStyle {
  readonly name: string;
  readonly radius: number;
  readonly width: number;
  readonly opacity: number;
  readonly longitudeSegments: number;
  readonly latitudeSegments: number;
  readonly verticalOffset: number;
}

const NEBULA_FORMATIONS: readonly NebulaFormationStyle[] = [
  {
    name: 'World-anchored spectral nebula curtain',
    radius: 8_780,
    width: 0.154,
    opacity: 0.215,
    longitudeSegments: 128,
    latitudeSegments: 12,
    verticalOffset: -0.017,
  },
  {
    name: 'World-anchored neon gas filaments',
    radius: 8_125,
    width: 0.058,
    opacity: 0.285,
    longitudeSegments: 112,
    latitudeSegments: 9,
    verticalOffset: 0.019,
  },
  {
    name: 'World-anchored cyan and amber dust tributaries',
    radius: 7_640,
    width: 0.026,
    opacity: 0.325,
    longitudeSegments: 96,
    latitudeSegments: 7,
    verticalOffset: -0.036,
  },
] as const;

/** Seeded connected spherical ribbons provide actual depth-separated gas structure. */
function createAnchoredNebulaFormation(
  seed: number,
  layer: number,
  atmosphericTransmittance = uniform(1),
  theme?: Readonly<SystemVisualTheme>,
): THREE.Mesh {
  const style = NEBULA_FORMATIONS[layer]!;
  const { longitudeSegments, latitudeSegments } = style;
  const vertexCount = (longitudeSegments + 1) * (latitudeSegments + 1);
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const bands = new Float32Array(vertexCount * 2);
  const indices: number[] = [];
  const phase = theme
    ? theme.orientationRadians + ((theme.seed >>> 7) & 255) / 255 * 0.16
    : ((seed >>> 5) & 1023) / 1023 * Math.PI * 2;
  const inclination = theme
    ? theme.inclinationRadians * (1.05 + layer * 0.07)
    : 0.12 + ((seed >>> 17) & 31) / 31 * 0.09;
  const radius = style.radius;
  const width = theme
    ? layer === 0
      ? THREE.MathUtils.clamp(theme.curtainWidth * (1.78 + theme.coverage * 0.34), 0.23, 0.41)
      : layer === 1
        ? THREE.MathUtils.clamp(theme.filamentWidth * (1.82 + theme.coverage * 0.27), 0.075, 0.16)
        : THREE.MathUtils.clamp(theme.filamentWidth * (0.93 + theme.coverage * 0.2), 0.035, 0.08)
    : style.width;
  const formationColors = theme
    ? theme.formationPalette.map((color) => new THREE.Color(color))
    : NEBULA_FORMATION_COLORS;
  const dustColors = theme?.dustPalette.map((color) => new THREE.Color(color));
  const stellarTint = theme ? new THREE.Color(theme.stellarHex) : undefined;
  const primaryTint = theme ? new THREE.Color(theme.primaryHex) : undefined;
  const secondaryTint = theme ? new THREE.Color(theme.secondaryHex) : undefined;
  const accentTint = theme ? new THREE.Color(theme.accentHex) : undefined;
  const spectralDust = theme ? new THREE.Color(
    theme.family === 'crimson-glacial' ? theme.accentHex : theme.dustHex,
  ) : undefined;
  const tint = new THREE.Color();

  for (let longitudeIndex = 0; longitudeIndex <= longitudeSegments; longitudeIndex += 1) {
    const longitude = longitudeIndex / longitudeSegments * Math.PI * 2 - Math.PI;
    // Every longitudinal harmonic must complete an integer number of turns:
    // the first and final meridians share a physical position on this sphere.
    // Fractional harmonics left their latitude/color mismatched and produced a
    // conspicuous hard rectangular seam when the wrap crossed the camera.
    const arm = Math.sin(longitude * 2 + phase) * inclination +
      Math.sin(longitude * 4 - phase * 0.7) * (
        theme ? 0.026 + theme.turbulence * 0.018 : 0.026
      );
    const branch = Math.sin(longitude * (layer + 3) + phase * (0.55 + layer * 0.19))
      * (theme
        ? (0.022 + layer * 0.016) * (0.72 + theme.turbulence * 0.53)
        : 0.016 + layer * 0.008);
    const lane = (Math.sin(longitude * 2 + phase) + 1) * 0.5;
    const pocket = (Math.sin(longitude * 3 - phase * 0.8) + 1) * 0.5;
    const atmosphericLobe = (Math.sin(longitude + phase * 0.57) + 1) * 0.5;
    const localWidth = theme
      ? width * (0.61 + lane * 0.33 + pocket * 0.27 + atmosphericLobe * 0.2)
      : width * (0.47 + lane * 0.42 + pocket * 0.36);
    // Explicitly wrap the normalized longitude so the final meridian shares
    // both geometry AND its exact themed vertex color with the first one.
    const wrappedLongitude = (longitudeIndex % longitudeSegments) / longitudeSegments;
    const palette = (Math.floor(
      wrappedLongitude * formationColors.length,
    ) + layer * 2 +
      Math.floor(lane * 2)) % formationColors.length;
    const nextPalette = (palette + (layer === 0 ? 1 : 2)) % formationColors.length;

    for (let latitudeIndex = 0; latitudeIndex <= latitudeSegments; latitudeIndex += 1) {
      const vertex = longitudeIndex * (latitudeSegments + 1) + latitudeIndex;
      const across = latitudeIndex / latitudeSegments * 2 - 1;
      const fold = Math.sin(longitude * 8 + across * 3.4 + phase) * localWidth * (
        theme ? 0.13 + theme.turbulence * 0.12 : 0.18
      ) + Math.sin(longitude * 11 - across * 5 + phase * 0.6) * localWidth * (
        theme ? 0.045 + theme.turbulence * 0.045 : 0.055
      );
      const liftedTributary = theme && layer === 1
        ? theme.curtainWidth * (0.37
          + Math.sin(longitude * 3 + phase * 0.91) * 0.24)
        : theme && layer === 2
          ? theme.curtainWidth * (0.19
            + Math.sin(longitude * 4 - phase * 0.53) * 0.18)
          : 0;
      const latitude = arm + branch + style.verticalOffset + liftedTributary + across * localWidth + fold;
      const radial = radius + Math.sin(longitude * 4 + across * 2 + phase) * (68 + layer * 14)
        + Math.sin(longitude * 7 - across * 3 + phase * 0.4) * 29;
      const planar = Math.cos(latitude);
      positions[vertex * 3] = Math.sin(longitude) * planar * radial;
      positions[vertex * 3 + 1] = Math.sin(latitude) * radial;
      positions[vertex * 3 + 2] = -Math.cos(longitude) * planar * radial;

      if (theme && primaryTint && secondaryTint && accentTint && spectralDust) {
        // Each physical depth-separated gas formation owns an actual local
        // spectral family. Walking one twelve-color wheel around the entire
        // sphere made a normal camera's narrow longitude slice monochrome.
        // Integer repeated lobes keep both authentic hues present from every
        // direction without attaching any gas to the viewer.
        const spectralLobe = (Math.sin(longitude * 5 + phase * 0.69 + across * 2.1) + 1) * 0.5;
        if (layer === 0) {
          tint.copy(primaryTint).lerp(accentTint, 0.12 + spectralLobe * 0.19);
          const upperIonization = Math.pow(
            Math.max(0, Math.sin(longitude * 4 - phase * 0.47 + across * 3.1)),
            4,
          ) * Math.max(0, across + 0.12);
          tint.lerp(secondaryTint, upperIonization * 0.47);
        } else if (layer === 1) {
          tint.copy(secondaryTint).lerp(spectralDust, 0.14 + spectralLobe * 0.24);
        } else {
          tint.copy(secondaryTint).lerp(spectralDust, 0.3 + spectralLobe * 0.3);
          tint.lerp(accentTint, Math.pow(1 - spectralLobe, 6) * 0.17);
        }
      } else {
        tint.copy(formationColors[palette]!).lerp(
          formationColors[nextPalette]!,
          THREE.MathUtils.clamp((across + 1) * 0.34 + lane * 0.28, 0, 1),
        );
      }
      if (theme && dustColors && stellarTint) {
        const ionVein = Math.pow(
          Math.max(0, Math.sin(longitude * (layer + 5) - across * 4 + phase * 0.73)),
          layer === 2 ? 5 : 8,
        ) * (1 - Math.min(1, Math.abs(across)));
        const dust = dustColors[(Math.floor(wrappedLongitude * dustColors.length) + layer)
          % dustColors.length]!;
        tint.lerp(dust, ionVein * (layer === 0 ? 0.14 : layer === 1 ? 0.1 : 0.16));
        const stellarRim = Math.pow(
          Math.max(0, Math.sin(longitude * 3 + phase * 0.42)),
          7,
        ) * Math.max(0, 1 - Math.abs(across * 1.45));
        tint.lerp(stellarTint, stellarRim * 0.08);
      }
      const intensity = theme
        ? (layer === 0
          ? 0.62 + lane * 0.23 + pocket * 0.14 + atmosphericLobe * 0.11
          : 0.92 + lane * 0.24 + pocket * 0.19) * theme.brightness
        : layer === 0
          ? 0.42 + lane * 0.2 + pocket * 0.12
          : 0.58 + lane * 0.22 + pocket * 0.16;
      colors[vertex * 3] = tint.r * intensity;
      colors[vertex * 3 + 1] = tint.g * intensity;
      colors[vertex * 3 + 2] = tint.b * intensity;
      bands[vertex * 2] = across;
      bands[vertex * 2 + 1] = longitude;
    }
  }

  for (let longitudeIndex = 0; longitudeIndex < longitudeSegments; longitudeIndex += 1) {
    for (let latitudeIndex = 0; latitudeIndex < latitudeSegments; latitudeIndex += 1) {
      const first = longitudeIndex * (latitudeSegments + 1) + latitudeIndex;
      const next = first + latitudeSegments + 1;
      indices.push(first, next, first + 1, first + 1, next, next + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('nebulaBand', new THREE.BufferAttribute(bands, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const band = attribute<'vec2'>('nebulaBand', 'vec2');
  const seedPhase = uniform(phase + layer * 1.73);
  const edge = band.x.abs().smoothstep(0.17, 0.97).oneMinus();
  const broad = band.y.mul(3).add(seedPhase).sin().mul(0.53).add(0.47);
  const folds = band.y.mul(10)
    .add(band.x.mul(8))
    .add(seedPhase.mul(1.4))
    .sin()
    .mul(0.5)
    .add(0.5)
    .pow(2.4)
    .mul(0.62)
    .add(0.38);
  const mineralVein = band.y.mul(15)
    .sub(band.x.mul(11))
    .add(seedPhase.mul(0.83))
    .sin()
    .mul(0.5)
    .add(0.5)
    .pow(layer === 0 ? 3.6 : 2.4);
  const connectedPocket = band.y.mul(2)
    .sub(seedPhase.mul(0.4))
    .sin()
    .mul(0.28)
    .add(0.72);
  const formationOpacity = edge
    .mul(broad.mul(0.19).add(folds.mul(0.34)).add(mineralVein.mul(0.16)).add(0.23))
    .mul(connectedPocket)
    .mul(style.opacity * (theme
      ? layer === 0
        ? 1.87 + theme.density * 0.38
        : layer === 1
          ? 2.23 + theme.density * 0.46
          : 1.65 + theme.density * 0.34
      : 1));

  const material = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    alphaTest: 0.008,
    toneMapped: false,
    fog: false,
  });
  material.colorNode = vec3(folds.mul(0.33).add(mineralVein.mul(0.16)).add(0.67));
  material.opacityNode = formationOpacity.mul(atmosphericTransmittance);
  material.userData.seedPhase = seedPhase;
  material.userData.atmosphericTransmittance = atmosphericTransmittance;

  const formation = new THREE.Mesh(geometry, material);
  formation.name = style.name;
  formation.frustumCulled = false;
  formation.renderOrder = -42 + layer;
  formation.userData.worldAnchored = true;
  formation.userData.diffuseGas = true;
  formation.userData.systemSeed = seed;
  formation.userData.physicalDepthRadius = radius;
  formation.userData.formationTriangles = indices.length / 3;
  formation.userData.connectedFilament = true;
  formation.userData.widthModulated = true;
  formation.userData.longitudeSegments = longitudeSegments;
  formation.userData.latitudeSegments = latitudeSegments;
  if (theme) {
    formation.userData.spaceThemeId = theme.id;
    formation.userData.spaceThemeFamily = theme.family;
    formation.userData.authenticSpectralTint = theme.stellarHex;
    formation.userData.themedHalfWidth = width;
  }
  return formation;
}

/** Runtime-generated soft sprites avoid imported textures and square point primitives. */
function createSpaceSprite(kind: SpaceSpriteKind): THREE.CanvasTexture {
  const size = kind === 'star' ? 96 : 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to initialize procedural space-sprite canvas.');

  const center = size / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  if (kind === 'star') {
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.065, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.165, 'rgba(255,255,255,0.89)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.29)');
    gradient.addColorStop(0.71, 'rgba(255,255,255,0.022)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    gradient.addColorStop(0, 'rgba(255,255,255,0.56)');
    gradient.addColorStop(0.17, 'rgba(255,255,255,0.39)');
    gradient.addColorStop(0.39, 'rgba(255,255,255,0.15)');
    gradient.addColorStop(0.67, 'rgba(255,255,255,0.032)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  if (kind === 'nebula') {
    // A few translucent polygonal planes give each diffuse cloud a folded
    // crystalline edge instead of a screen full of unrelated round smudges.
    // They remain gas sprites: none is a discrete or targetable catalog star.
    context.globalCompositeOperation = 'screen';
    const facets: Array<{ alpha: number; points: Array<readonly [number, number]> }> = [
      { alpha: 0.072, points: [[0.16, 0.48], [0.39, 0.23], [0.58, 0.34], [0.41, 0.67]] },
      { alpha: 0.088, points: [[0.39, 0.23], [0.65, 0.21], [0.79, 0.46], [0.58, 0.34]] },
      { alpha: 0.054, points: [[0.41, 0.67], [0.58, 0.34], [0.79, 0.46], [0.68, 0.76]] },
      { alpha: 0.03, points: [[0.23, 0.59], [0.41, 0.67], [0.68, 0.76], [0.41, 0.83]] },
    ];
    for (const facet of facets) {
      const [first, ...rest] = facet.points;
      if (!first) continue;
      context.beginPath();
      context.moveTo(first[0] * size, first[1] * size);
      for (const point of rest) context.lineTo(point[0] * size, point[1] * size);
      context.closePath();
      context.fillStyle = `rgba(255,255,255,${facet.alpha})`;
      context.fill();
    }

    // Screen compositing can otherwise leave a hard repeated polygon outside
    // the original falloff. Multiply the *finished* cloud by a genuine alpha
    // envelope so its internal planes remain subtle and its silhouette soft.
    const mask = context.createRadialGradient(center, center, center * 0.12, center, center, center);
    mask.addColorStop(0, 'rgba(255,255,255,1)');
    mask.addColorStop(0.39, 'rgba(255,255,255,0.79)');
    mask.addColorStop(0.71, 'rgba(255,255,255,0.18)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    context.globalCompositeOperation = 'destination-in';
    context.fillStyle = mask;
    context.fillRect(0, 0, size, size);
    context.globalCompositeOperation = 'source-over';
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function dominantCatalogStar(system: StarSystem): StarDescriptor | undefined {
  return system.stars.reduce<StarDescriptor | undefined>((dominant, candidate) => (
    !dominant || candidate.luminositySolar > dominant.luminositySolar ? candidate : dominant
  ), undefined);
}

/** Binary destinations inherit the luminosity-weighted spectrum of their real suns. */
function catalogStarColor(system: StarSystem): THREE.Color {
  const combined = new THREE.Color(0, 0, 0);
  let totalWeight = 0;

  for (const star of system.stars) {
    const contribution = Math.max(0.035, Math.sqrt(Math.max(0, star.luminositySolar)));
    const physicalColor = new THREE.Color(star.color);
    combined.r += physicalColor.r * contribution;
    combined.g += physicalColor.g * contribution;
    combined.b += physicalColor.b * contribution;
    totalWeight += contribution;
  }

  if (totalWeight === 0) return new THREE.Color(PALETTE.white);
  combined.multiplyScalar(1 / totalWeight);

  const primary = dominantCatalogStar(system);
  const temperature = primary?.temperatureKelvin ?? 5_778;
  const hot = THREE.MathUtils.clamp((temperature - 6_200) / 3_200, 0, 1);
  const cool = THREE.MathUtils.clamp((4_700 - temperature) / 2_200, 0, 1);
  if (hot > 0) combined.lerp(new THREE.Color(PALETTE.cyan), hot * 0.13);
  if (cool > 0) combined.lerp(new THREE.Color(PALETTE.sunRed), cool * 0.11);
  return combined.lerp(new THREE.Color(PALETTE.white), 0.11 + hot * 0.08);
}

const CATALOG_STAR_RENDER_RADIUS = 9_500;
/** Less than 0.03 pixel at the supported 1,920 × 1,200 / 30° extreme. */
export const CATALOG_STAR_MAX_ANGULAR_ERROR_RADIANS = 1e-5;
// Each component is at most 9,500, whose float32 half-ULP is 2^-11.
// asin(sqrt(3) * 2^-11 / 9,500) < 1e-7, including normalization error.
const CATALOG_STAR_FLOAT32_ANGULAR_ERROR_RADIANS = 1e-7;

export interface CatalogStarObserverDiagnostics {
  /** Observer used for the last accepted direction-buffer projection. */
  readonly lastObserverAddress: GalacticAddress;
  readonly updateCount: number;
  /** Conservative angular error of visible stars at the most recent request. */
  readonly maxAngularErrorBound: number;
  readonly angularToleranceRadians: number;
  readonly nearestSystemDistanceMeters: number;
  readonly coincidentSystemCount: number;
}

/** Every rendered point is still one actual catalog system and retains its exact raycast index. */
export class CatalogStars {
  readonly points: THREE.Points;
  readonly systemIds: string[] = [];
  /** Shared real-atmosphere extinction node; never changes catalog destinations. */
  readonly atmosphericTransmittance = uniform(1);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly sprite: THREE.CanvasTexture;
  private readonly spectralSprites: THREE.Sprite;
  private readonly catalogAddresses: GalacticAddress[] = [];
  private readonly positionAttribute: THREE.Float32BufferAttribute;
  private readonly distanceAttribute: THREE.Float32BufferAttribute;
  private readonly sizeAttribute: THREE.Float32BufferAttribute;
  private readonly instancePositions: THREE.InstancedBufferAttribute;
  private readonly instanceSizes: THREE.InstancedBufferAttribute;
  private readonly originalSizes: Float32Array;
  private lastProjectedObserver: GalacticAddress;
  private nearestProjectionDistanceMeters = Number.POSITIVE_INFINITY;
  private projectionUpdateCount = 0;
  private projectionAngularErrorBound = CATALOG_STAR_FLOAT32_ANGULAR_ERROR_RADIANS;
  private coincidentSystemCount = 0;

  constructor(systems: StarSystem[], origin: GalacticAddress) {
    this.lastProjectedObserver = cloneAddress(origin);
    const coordinates: number[] = [];
    const colors: number[] = [];
    const sizes: number[] = [];
    const stellarLuminosities: number[] = [];
    const physicalDistances: number[] = [];
    const scintillations: number[] = [];

    for (const system of systems) {
      const relative = subtractAddresses(system.position, origin);
      const magnitude = Math.hypot(relative.x, relative.y, relative.z);
      if (magnitude < 1) continue;

      coordinates.push(
        (relative.x / magnitude) * CATALOG_STAR_RENDER_RADIUS,
        (relative.y / magnitude) * CATALOG_STAR_RENDER_RADIUS,
        (relative.z / magnitude) * CATALOG_STAR_RENDER_RADIUS,
      );
      this.catalogAddresses.push(cloneAddress(system.position));
      this.nearestProjectionDistanceMeters = Math.min(this.nearestProjectionDistanceMeters, magnitude);
      const tone = catalogStarColor(system);
      colors.push(tone.r, tone.g, tone.b);
      const luminosity = system.stars.reduce((sum, star) => sum + star.luminositySolar, 0);
      const primary = dominantCatalogStar(system);
      const distanceLightYears = magnitude / LIGHT_YEAR_METERS;
      const radiusSolar = (primary?.radiusMeters ?? SOLAR_RADIUS_METERS) / SOLAR_RADIUS_METERS;
      const temperatureKelvin = primary?.temperatureKelvin ?? 5_778;
      const apparentLuminosity = Math.sqrt(Math.max(0, luminosity))
        / (1 + distanceLightYears * 0.065);
      const physicalProminence = Math.log2(1 + apparentLuminosity) * 0.41;
      const radiusProminence = Math.min(0.29, Math.max(0, radiusSolar) * 0.105);
      const spectralSubtype = THREE.MathUtils.clamp(primary?.spectralSubtype ?? 4, 0, 9) * 0.007;
      sizes.push(THREE.MathUtils.clamp(
        0.64 + physicalProminence + radiusProminence + spectralSubtype,
        0.68,
        2.12,
      ));
      stellarLuminosities.push(luminosity);
      physicalDistances.push(distanceLightYears);

      const actualStarSeed = primary?.seed ?? system.seed;
      const scintillationPhase = (actualStarSeed & 0xffff) / 0xffff * Math.PI * 2;
      const scintillationFrequency = 0.31
        + THREE.MathUtils.clamp(temperatureKelvin / 12_000, 0.15, 0.82) * 0.46;
      const scintillationAmplitude = THREE.MathUtils.clamp(
        0.024
          + (1 - Math.min(temperatureKelvin, 9_000) / 9_000) * 0.036
          + ((actualStarSeed >>> 16) & 255) / 255 * 0.016,
        0.022,
        0.078,
      );
      scintillations.push(scintillationPhase, scintillationFrequency, scintillationAmplitude);
      this.systemIds.push(system.id);
    }

    this.positionAttribute = new THREE.Float32BufferAttribute(coordinates, 3)
      .setUsage(THREE.DynamicDrawUsage);
    this.sizeAttribute = new THREE.Float32BufferAttribute(sizes, 1)
      .setUsage(THREE.DynamicDrawUsage);
    this.distanceAttribute = new THREE.Float32BufferAttribute(physicalDistances, 1)
      .setUsage(THREE.DynamicDrawUsage);
    this.originalSizes = new Float32Array(this.sizeAttribute.array);
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.geometry.setAttribute('starScale', this.sizeAttribute);
    this.geometry.setAttribute('stellarLuminosity', new THREE.Float32BufferAttribute(stellarLuminosities, 1));
    this.geometry.setAttribute('distanceLightYears', this.distanceAttribute);
    this.geometry.setAttribute('starScintillation', new THREE.Float32BufferAttribute(scintillations, 3));
    // Raycasts must not retain a sphere fitted to an earlier FTL viewpoint.
    // All accepted directions lie on this sphere, including float32 rounding.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), CATALOG_STAR_RENDER_RADIUS + 0.001);
    this.sprite = createSpaceSprite('star');

    // WebGPU point primitives are permanently one pixel wide. Keep the exact
    // catalog Points object for indexed raycasts, but draw its very same real
    // systems as one instanced sprite batch instead of doubling the stars.
    const targetMaterial = new THREE.PointsNodeMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      visible: false,
      fog: false,
      toneMapped: false,
    });
    this.points = new THREE.Points(this.geometry, targetMaterial);

    this.instancePositions = new THREE.InstancedBufferAttribute(
      this.positionAttribute.array,
      3,
    ).setUsage(THREE.DynamicDrawUsage);
    const instanceColors = new THREE.InstancedBufferAttribute(
      this.geometry.getAttribute('color').array as Float32Array,
      3,
    );
    this.instanceSizes = new THREE.InstancedBufferAttribute(
      this.sizeAttribute.array,
      1,
    ).setUsage(THREE.DynamicDrawUsage);
    const instanceScintillations = new THREE.InstancedBufferAttribute(
      this.geometry.getAttribute('starScintillation').array as Float32Array,
      3,
    );
    const coordinatesNode = instancedDynamicBufferAttribute<'vec3'>(this.instancePositions, 'vec3');
    const spectrum = instancedBufferAttribute<'vec3'>(instanceColors, 'vec3');
    const scale = instancedDynamicBufferAttribute<'float'>(this.instanceSizes, 'float');
    const scintillation = instancedBufferAttribute<'vec3'>(instanceScintillations, 'vec3');
    const stellarShimmer = time.mul(scintillation.y)
      .add(scintillation.x)
      .sin()
      .mul(scintillation.z)
      .add(1);
    const starUV = uv();
    const sample = texture(this.sprite, starUV);
    const offset = starUV.sub(0.5);
    const center = offset.length().mul(2).oneMinus().max(0);
    const horizontalDiffraction = offset.x.abs().mul(-38).exp()
      .mul(offset.y.abs().mul(-7).exp());
    const verticalDiffraction = offset.y.abs().mul(-38).exp()
      .mul(offset.x.abs().mul(-7).exp());
    const diffraction = horizontalDiffraction.add(verticalDiffraction);
    const luminous = mix(spectrum, vec3(1), center.pow(7).mul(0.37));
    const spectralMaterial = new THREE.PointsNodeMaterial({
      size: 5.05,
      sizeAttenuation: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      alphaTest: 0.014,
      toneMapped: false,
      fog: false,
    });
    spectralMaterial.positionNode = coordinatesNode;
    spectralMaterial.sizeNode = scale.mul(5.05);
    spectralMaterial.colorNode = luminous.mul(
      center.mul(0.43).add(diffraction.mul(0.075)).add(0.79),
    ).mul(stellarShimmer);
    spectralMaterial.opacityNode = sample.a
      .mul(diffraction.mul(0.085).add(0.93))
      .mul(stellarShimmer)
      .mul(this.atmosphericTransmittance)
      .min(1);
    spectralMaterial.userData.atmosphericTransmittance = this.atmosphericTransmittance;
    this.spectralSprites = new THREE.Sprite(spectralMaterial);
    this.spectralSprites.name = 'Instanced reachable catalog / spectral diffraction';
    this.spectralSprites.count = this.systemIds.length;
    this.spectralSprites.frustumCulled = false;
    this.spectralSprites.renderOrder = -20;
    this.spectralSprites.userData.catalogBacked = true;
    this.spectralSprites.userData.systemIds = this.systemIds;
    this.spectralSprites.userData.instanceCount = this.systemIds.length;
    this.spectralSprites.userData.sharedCatalogPositions = true;
    this.spectralSprites.userData.descriptorDrivenSpectra = true;
    this.spectralSprites.userData.boundedScintillation = true;
    this.spectralSprites.userData.maximumScintillationAmplitude = 0.078;
    this.spectralSprites.userData.atmosphericTransmittance = this.atmosphericTransmittance;
    this.points.add(this.spectralSprites);
    this.points.name = `Reachable catalog / ${this.systemIds.length} systems`;
    this.points.userData.systemIds = this.systemIds;
    this.points.userData.catalogBacked = true;
    this.points.userData.sharpSpectralDiffraction = true;
    this.points.userData.descriptorDrivenSpectra = true;
    this.points.userData.realStellarLuminosity = true;
    this.points.userData.boundedScintillation = true;
    this.points.userData.atmosphericTransmittance = this.atmosphericTransmittance;
    this.points.userData.observerRelativeDirections = true;
    this.points.userData.angularErrorToleranceRadians = CATALOG_STAR_MAX_ANGULAR_ERROR_RADIANS;
    this.points.frustumCulled = false;
    this.points.renderOrder = -20;
  }

  get observerDiagnostics(): CatalogStarObserverDiagnostics {
    return {
      lastObserverAddress: cloneAddress(this.lastProjectedObserver),
      updateCount: this.projectionUpdateCount,
      maxAngularErrorBound: this.projectionAngularErrorBound,
      angularToleranceRadians: CATALOG_STAR_MAX_ANGULAR_ERROR_RADIANS,
      nearestSystemDistanceMeters: this.nearestProjectionDistanceMeters,
      coincidentSystemCount: this.coincidentSystemCount,
    };
  }

  /**
   * Keep the same catalog/raycast indices and spectral instance buffer while
   * projecting genuine galactic addresses from the active physical observer.
   * Walking does not upload thousands of effectively unchanged bearings. If
   * the observer moved d from the last projection and its nearest star was r
   * away, asin(d/r) bounds every bearing change while d < r. Real FTL motion
   * exceeds that bound and updates the existing buffers immediately.
   */
  setObserverAddress(observer: GalacticAddress): boolean {
    const displacement = subtractAddresses(observer, this.lastProjectedObserver);
    const movedMeters = Math.hypot(displacement.x, displacement.y, displacement.z);
    if (!Number.isFinite(movedMeters)) {
      throw new RangeError('Catalog-star observer coordinates must be finite.');
    }
    const movementError = movedMeters === 0
      ? 0
      : movedMeters < this.nearestProjectionDistanceMeters
        ? Math.asin(movedMeters / this.nearestProjectionDistanceMeters)
        : Math.PI;
    this.projectionAngularErrorBound = Math.min(
      Math.PI,
      movementError + CATALOG_STAR_FLOAT32_ANGULAR_ERROR_RADIANS,
    );
    if (this.projectionAngularErrorBound <= CATALOG_STAR_MAX_ANGULAR_ERROR_RADIANS) return false;

    let nearestDistance = Number.POSITIVE_INFINITY;
    let coincidentCount = 0;
    let sizesChanged = false;
    for (let index = 0; index < this.catalogAddresses.length; index += 1) {
      const relative = subtractAddresses(this.catalogAddresses[index]!, observer);
      const distance = Math.hypot(relative.x, relative.y, relative.z);
      nearestDistance = Math.min(nearestDistance, distance);
      this.distanceAttribute.setX(index, distance / LIGHT_YEAR_METERS);

      // Direction is undefined exactly at a system's barycenter. Keep the
      // last finite raycast bearing and hide its optical point for this brief
      // transition; the actual system rebuild removes its local catalog entry.
      const coincident = distance < 1;
      if (coincident) coincidentCount += 1;
      else {
        const factor = CATALOG_STAR_RENDER_RADIUS / distance;
        this.positionAttribute.setXYZ(index, relative.x * factor, relative.y * factor, relative.z * factor);
      }
      const size = coincident ? 0 : this.originalSizes[index]!;
      if (this.sizeAttribute.getX(index) !== size) {
        this.sizeAttribute.setX(index, size);
        sizesChanged = true;
      }
    }
    // These attributes intentionally share their Float32Array but have
    // distinct Three.js upload versions: update both real consumers.
    this.positionAttribute.needsUpdate = true;
    this.instancePositions.needsUpdate = true;
    this.distanceAttribute.needsUpdate = true;
    if (sizesChanged) {
      this.sizeAttribute.needsUpdate = true;
      this.instanceSizes.needsUpdate = true;
    }
    this.lastProjectedObserver = cloneAddress(observer);
    this.nearestProjectionDistanceMeters = nearestDistance;
    this.coincidentSystemCount = coincidentCount;
    this.projectionAngularErrorBound = CATALOG_STAR_FLOAT32_ANGULAR_ERROR_RADIANS;
    this.projectionUpdateCount += 1;
    return true;
  }

  /** Apply smooth physical extinction without moving or removing any real star. */
  setAtmosphericTransmittance(transmittance: number): void {
    this.atmosphericTransmittance.value = Number.isFinite(transmittance)
      ? THREE.MathUtils.clamp(transmittance, 0, 1)
      : 1;
  }

  /**
   * The same real atmosphere reveals its catalog at night and overwhelms it in
   * daylight. Occluded suns reduce the caller's actual receiver daylight, so a
   * genuine eclipse naturally restores the very same reachable stars.
   */
  setAtmosphericLighting(
    atmosphericDensity: number,
    daylight: number,
    opticalDepth = 0,
  ): void {
    const density = Number.isFinite(atmosphericDensity)
      ? THREE.MathUtils.clamp(atmosphericDensity, 0, 1)
      : 0;
    const illumination = Number.isFinite(daylight)
      ? THREE.MathUtils.clamp(daylight, 0, 1)
      : 0;
    const cloudDepth = Number.isFinite(opticalDepth)
      ? THREE.MathUtils.clamp(opticalDepth, 0, 1)
      : 0;
    const adaptedDaylight = THREE.MathUtils.smoothstep(illumination, 0.018, 0.76);
    // Clear night air dims background starlight only gently. Real daylight
    // raises the atmospheric sky radiance instead; no catalog target is ever
    // replaced, detached, culled, or removed from its original draw batch.
    const clearAirExtinction = density * (0.19 + cloudDepth * 0.58);
    const daylightExtinction = density * adaptedDaylight *
      (3.9 + illumination * 2.35 + cloudDepth * 1.15);
    this.setAtmosphericTransmittance(
      Math.exp(-clearAirExtinction - daylightExtinction),
    );
  }

  dispose(): void {
    this.points.remove(this.spectralSprites);
    (this.spectralSprites.material as THREE.Material).dispose();
    this.geometry.dispose();
    this.sprite.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Seeded diffuse gas; these broad translucent sprites never represent targetable stars. */
export function generateNebulaLayer(
  seed: number,
  layer: number,
  theme?: Readonly<SystemVisualTheme>,
): NebulaLayerLayout {
  const style = NEBULA_LAYERS[THREE.MathUtils.clamp(Math.round(layer), 0, NEBULA_LAYERS.length - 1)]!;
  const random = new SeededRandom(seed ^ Math.imul(layer + 1, 0x9e37_79b1));
  const positions = new Float32Array(style.count * 3);
  const colors = new Float32Array(style.count * 3);
  const colorspace = theme
    ? theme.nebulaPalette.map((color) => new THREE.Color(color))
    : [
      new THREE.Color('#271343'),
      new THREE.Color('#51307F'),
      new THREE.Color('#893B93'),
      new THREE.Color('#313979'),
      new THREE.Color('#11546C'),
      new THREE.Color('#16838C'),
      new THREE.Color('#AC4A89'),
      new THREE.Color('#574394'),
      new THREE.Color('#8B576E'),
    ];
  const dustColors = theme?.dustPalette.map((color) => new THREE.Color(color));
  const primaryTint = theme ? new THREE.Color(theme.primaryHex) : undefined;
  const secondaryTint = theme ? new THREE.Color(theme.secondaryHex) : undefined;
  const accentTint = theme ? new THREE.Color(theme.accentHex) : undefined;
  const spectralDust = theme ? new THREE.Color(
    theme.family === 'crimson-glacial' ? theme.accentHex : theme.dustHex,
  ) : undefined;
  const gasTint = new THREE.Color();
  const phase = theme
    ? theme.orientationRadians + ((theme.seed >>> 7) & 255) / 255 * 0.16
    : ((seed >>> 5) & 1023) / 1023 * Math.PI * 2;
  const inclination = theme
    ? theme.inclinationRadians * 1.05
    : 0.12 + ((seed >>> 17) & 31) / 31 * 0.09;
  const gasSpread = theme
    ? style.spread * (layer === 0
      ? 1.74 + theme.coverage * 0.49
      : layer === 1
        ? 1.44 + theme.coverage * 0.36
        : 1.17 + theme.turbulence * 0.24)
    : style.spread;

  for (let index = 0; index < style.count; index += 1) {
    const longitude = random.range(-Math.PI, Math.PI);
    const arm = Math.sin(longitude * 2 + phase) * inclination +
      Math.sin(longitude * 4 - phase * 0.7) * (
        theme ? 0.026 + theme.turbulence * 0.016 : 0.026
      );
    const branch = theme
      ? index % 17 < 5
        ? Math.sin(longitude * 3 + phase * 0.65) * theme.curtainWidth * 0.26
          + theme.curtainWidth * 0.19
        : index % 23 < 3
          ? -theme.curtainWidth * 0.29
          : 0
      : index % 17 < 4
        ? Math.sin(longitude * 3 + phase * 0.65) * 0.032 + 0.026
        : index % 23 === 0 ? -0.041 : 0;
    const density = random.range(-gasSpread, gasSpread) * random.range(0.23, 0.93);
    const latitude = arm + branch + density;
    const distance = style.radius + random.range(-180, 210);
    const planar = Math.cos(latitude);
    positions[index * 3] = Math.sin(longitude) * planar * distance;
    positions[index * 3 + 1] = Math.sin(latitude) * distance;
    positions[index * 3 + 2] = -Math.cos(longitude) * planar * distance;

    const lane = (Math.sin(longitude * 2 + phase) + 1) * 0.5;
    const ribbon = Math.floor(((longitude + Math.PI) / (Math.PI * 2)) * colorspace.length);
    const accent = index % 9 < 2 ? 1 : index % 17 === 0 ? 3 : 0;
    const paletteIndex = (ribbon + Math.floor(lane * 2) + accent + layer) % colorspace.length;
    if (theme && primaryTint && secondaryTint && accentTint && spectralDust) {
      const spectralLobe = (Math.sin(longitude * 5 + phase * 0.69) + 1) * 0.5;
      if (layer === 0) {
        gasTint.copy(primaryTint).lerp(accentTint, spectralLobe * 0.2);
      } else if (layer === 1 || layer === 3) {
        gasTint.copy(secondaryTint).lerp(spectralDust, 0.13 + spectralLobe * 0.28);
      } else {
        gasTint.copy(index % 7 < 3 ? secondaryTint : primaryTint);
        gasTint.lerp(index % 7 < 3 ? spectralDust : accentTint, spectralLobe * 0.24);
      }
      if (dustColors && index % 23 === 0) {
        gasTint.lerp(dustColors[(index + layer) % dustColors.length]!, 0.14);
      }
    } else {
      gasTint.copy(colorspace[paletteIndex]!);
    }
    const ridge = 1 - Math.min(1, Math.abs(density) / Math.max(gasSpread, 0.001));
    const strength = random.range(0.48, 0.9) * (0.73 + ridge * 0.34) * style.brightness
      * (theme ? theme.brightness * (1.06 + theme.density * 0.34) : 1);
    colors[index * 3] = gasTint.r * strength;
    colors[index * 3 + 1] = gasTint.g * strength;
    colors[index * 3 + 2] = gasTint.b * strength;
  }

  return { count: style.count, positions, colors };
}

export function createNebula(
  seed: number,
  atmosphericTransmittance = uniform(1),
  theme?: Readonly<SystemVisualTheme>,
): THREE.Points {
  const sprite = createSpaceSprite('nebula');
  const entries: Array<{
    geometry: THREE.BufferGeometry;
    material: THREE.PointsNodeMaterial;
    spriteMaterial: THREE.PointsNodeMaterial;
  }> = [];
  const formations: THREE.Mesh[] = [];

  const makeLayer = (index: number): THREE.Points => {
    const style = NEBULA_LAYERS[index]!;
    const layout = generateNebulaLayer(seed, index, theme);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(layout.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(layout.colors, 3));
    const material = new THREE.PointsNodeMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      visible: false,
      fog: false,
      toneMapped: false,
    });
    const spriteMaterial = new THREE.PointsNodeMaterial({
      size: style.size,
      sizeAttenuation: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      alphaTest: 0.003,
      toneMapped: false,
      fog: false,
    });
    const gasPositions = new THREE.InstancedBufferAttribute(layout.positions, 3);
    const gasColors = new THREE.InstancedBufferAttribute(layout.colors, 3);
    const shapedWisps = new Float32Array(style.count * 3);
    const phase = theme
      ? theme.orientationRadians + ((theme.seed >>> 7) & 255) / 255 * 0.16
      : ((seed >>> 5) & 1023) / 1023 * Math.PI * 2;
    for (let wisp = 0; wisp < style.count; wisp += 1) {
      const longitude = Math.atan2(layout.positions[wisp * 3]!, -layout.positions[wisp * 3 + 2]!);
      const grain = ((Math.imul(wisp + 1, 0x9e37_79b1) ^ seed) >>> 0) / 0xffff_ffff;
      shapedWisps[wisp * 3] = (1.14 + grain * 0.75) * (
        theme ? 1.04 + theme.coverage * 0.15 : 1
      );
      shapedWisps[wisp * 3 + 1] = (0.54 + (1 - grain) * 0.21) * (
        theme ? 1.08 + theme.coverage * 0.19 : 1
      );
      shapedWisps[wisp * 3 + 2] = Math.sin(longitude * 2 + phase) * 0.24
        + Math.sin(longitude * 5 - phase) * (
          theme ? 0.13 + theme.turbulence * 0.075 : 0.13
        );
    }
    const gasShapes = new THREE.InstancedBufferAttribute(shapedWisps, 3);
    const wispShape = instancedBufferAttribute<'vec3'>(gasShapes, 'vec3');
    const gasSample = texture(sprite, uv());
    spriteMaterial.positionNode = instancedBufferAttribute<'vec3'>(gasPositions, 'vec3');
    spriteMaterial.sizeNode = vec2(wispShape.x.mul(style.size), wispShape.y.mul(style.size));
    spriteMaterial.rotationNode = wispShape.z;
    spriteMaterial.colorNode = instancedBufferAttribute<'vec3'>(gasColors, 'vec3');
    const themedOpacity = style.opacity * (theme
      ? index === 0
        ? 1.28 + theme.density * 0.37
        : index === 1
          ? 1.21 + theme.density * 0.31
          : 1.12 + theme.density * 0.22
      : 1);
    spriteMaterial.opacityNode = gasSample.a.mul(themedOpacity).mul(atmosphericTransmittance);
    spriteMaterial.userData.atmosphericTransmittance = atmosphericTransmittance;
    if (theme) spriteMaterial.userData.spaceThemeId = theme.id;
    entries.push({ geometry, material, spriteMaterial });
    const points = new THREE.Points(geometry, material);
    points.name = `Diffuse anchored nebula / layer ${index + 1}`;
    points.userData.diffuseGas = true;
    points.userData.systemSeed = seed;
    points.userData.spriteCount = style.count;
    points.renderOrder = -35 + index;
    points.frustumCulled = false;

    const clouds = new THREE.Sprite(spriteMaterial);
    clouds.name = `Instanced anchored nebula gas / layer ${index + 1}`;
    clouds.count = style.count;
    clouds.frustumCulled = false;
    clouds.renderOrder = -35 + index;
    clouds.userData.diffuseGas = true;
    clouds.userData.worldAnchored = true;
    clouds.userData.systemSeed = seed;
    clouds.userData.instanceCount = style.count;
    clouds.userData.elongatedWisps = true;
    clouds.userData.maximumAspectRatio = 3.5;
    clouds.userData.atmosphericTransmittance = atmosphericTransmittance;
    if (theme) {
      clouds.userData.spaceThemeId = theme.id;
      clouds.userData.spaceThemeFamily = theme.family;
      clouds.userData.authenticSpectralTint = theme.stellarHex;
    }
    points.add(clouds);
    return points;
  };

  const root = makeLayer(0);
  root.name = 'Anchored violet nebula';
  root.userData.layerCount = NEBULA_LAYERS.length;
  root.userData.worldAnchored = true;
  root.userData.facetedDiffuseGas = true;
  root.userData.radiallyMasked = true;
  root.userData.darkSkyPreserved = true;
  root.userData.formationCount = NEBULA_FORMATIONS.length;
  root.userData.connectedGasStructures = true;
  root.userData.physicalDepthRadii = NEBULA_FORMATIONS.map((formation) => formation.radius);
  root.userData.drawBatchCount = NEBULA_LAYERS.length + NEBULA_FORMATIONS.length;
  root.userData.atmosphericTransmittance = atmosphericTransmittance;
  root.userData.setAtmosphericTransmittance = (transmittance: number): void => {
    atmosphericTransmittance.value = Number.isFinite(transmittance)
      ? THREE.MathUtils.clamp(transmittance, 0, 1)
      : 1;
  };
  root.userData.maximumPointSize = NEBULA_LAYERS[0]!.size;
  root.userData.totalDiffuseSprites = NEBULA_LAYERS.reduce((sum, layer) => sum + layer.count, 0);
  if (theme) {
    root.userData.spaceThemeId = theme.id;
    root.userData.spaceThemeName = theme.name;
    root.userData.spaceThemeFamily = theme.family;
    root.userData.spaceThemeSeed = theme.seed;
    root.userData.spaceThemeVersion = theme.version;
    root.userData.paletteHex = [...theme.nebulaPalette];
    root.userData.formationPaletteHex = [...theme.formationPalette];
    root.userData.dustPaletteHex = [...theme.dustPalette];
    root.userData.authenticSpectralTint = theme.stellarHex;
    root.userData.dominantStarId = theme.dominantStarId;
    root.userData.density = theme.density;
    root.userData.coverage = theme.coverage;
    root.userData.curtainWidth = theme.curtainWidth;
    root.userData.filamentWidth = theme.filamentWidth;
    root.userData.brightness = theme.brightness;
    root.userData.orientationRadians = theme.orientationRadians;
    root.userData.inclinationRadians = theme.inclinationRadians;
    root.userData.sectorSeed = theme.sectorSeed;
  }
  for (let index = 0; index < NEBULA_FORMATIONS.length; index += 1) {
    const formation = createAnchoredNebulaFormation(seed, index, atmosphericTransmittance, theme);
    formations.push(formation);
    root.add(formation);
  }
  for (let index = 1; index < NEBULA_LAYERS.length; index += 1) root.add(makeLayer(index));

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    root.removeEventListener('removed', dispose);
    for (const entry of entries) {
      entry.geometry.dispose();
      entry.material.dispose();
      entry.spriteMaterial.dispose();
    }
    for (const formation of formations) {
      formation.geometry.dispose();
      (formation.material as THREE.Material).dispose();
    }
    sprite.dispose();
  };
  root.addEventListener('removed', dispose);
  root.userData.dispose = dispose;
  return root;
}

export function createStarMesh(color: string | number, radius: number): THREE.Group {
  const photosphereRadiance = 3.1;
  const group = new THREE.Group();
  const tone = new THREE.Color(color);
  const white = new THREE.Color('#FFF5DF');
  const goldenWeight = THREE.MathUtils.clamp((tone.g - tone.b) * 1.9, 0, 0.78);
  const scarletWeight = (1 - goldenWeight) * THREE.MathUtils.clamp((tone.r - tone.g) * 0.68, 0, 0.5);
  const radiantSpectrum = tone.clone()
    .lerp(new THREE.Color('#FFE640'), goldenWeight * 0.68)
    .lerp(new THREE.Color('#FF386E'), scarletWeight);
  const geometry = new THREE.IcosahedronGeometry(radius, 2);
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  const facetEnergies = new Float32Array(positions.count);

  for (let index = 0; index < positions.count; index += 1) {
    const start = Math.floor(index / 3) * 3;
    const x = (positions.getX(start) + positions.getX(start + 1) + positions.getX(start + 2)) /
      (radius * 3);
    const y = (positions.getY(start) + positions.getY(start + 1) + positions.getY(start + 2)) /
      (radius * 3);
    const z = (positions.getZ(start) + positions.getZ(start + 1) + positions.getZ(start + 2)) /
      (radius * 3);
    const circulation = Math.sin(y * 10.8 + x * 4.6 + z * 2.3);
    const convection = Math.sin(x * 22.7 + z * 15.4) * Math.cos(y * 17.9 - z * 9.6);
    const energy = THREE.MathUtils.clamp(0.46 + circulation * 0.23 + convection * 0.24, 0.05, 0.98);
    const facetEnergy = Math.round(energy * 6) / 6;
    const facet = tone.clone()
      .multiplyScalar(0.62 + facetEnergy * 0.35)
      .lerp(white, 0.07 + facetEnergy * 0.19);
    colors[index * 3] = facet.r;
    colors[index * 3 + 1] = facet.g;
    colors[index * 3 + 2] = facet.b;
    facetEnergies[index] = facetEnergy;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('stellarFacetEnergy', new THREE.BufferAttribute(facetEnergies, 1));
  geometry.userData.segmentedConvection = true;
  geometry.userData.physicalFacetCount = positions.count / 3;
  const photosphereMaterial = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    toneMapped: false,
    fog: false,
  });
  // NodeMaterial multiplies vertex colors after colorNode automatically. A
  // neutral HDR multiplier keeps each actual spectral facet exactly once.
  photosphereMaterial.colorNode = vec3(photosphereRadiance, photosphereRadiance, photosphereRadiance);
  photosphereMaterial.userData.hdrRadiance = photosphereRadiance;
  photosphereMaterial.userData.segmentedPhotosphere = true;
  photosphereMaterial.userData.descriptorSpectralColor = tone.getHexString();
  const core = new THREE.Mesh(geometry, photosphereMaterial);
  core.name = 'Actual stellar body / faceted photosphere';
  group.add(core);

  const haloColors = [
    radiantSpectrum.clone().lerp(white, 0.14),
    radiantSpectrum.clone(),
    radiantSpectrum.clone().lerp(new THREE.Color(PALETTE.sunRed), 0.12),
    tone.clone().lerp(new THREE.Color(PALETTE.violet), 0.075),
  ];
  const scales = [1.09, 1.34, 1.83, 2.55];
  const opacities = [0.69, 0.43, 0.225, 0.07];
  const radiances = [2.34, 1.9, 1.43, 0.96];

  for (let index = 0; index < scales.length; index += 1) {
    const shellMaterial = new THREE.MeshBasicNodeMaterial({
      color: haloColors[index],
      transparent: true,
      opacity: opacities[index],
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    const sight = cameraPosition.sub(positionWorld).normalize();
    const limb = float(1).sub(normalWorld.normalize().dot(sight).abs()).max(0);
    const coronalLatitude = positionLocal.y.div(radius * scales[index]!);
    const magneticThreads = coronalLatitude.mul(7 + index * 2)
      .add(positionLocal.x.div(radius).mul(2.8 + index))
      .add(time.mul(0.065 + index * 0.017))
      .sin()
      .mul(0.075)
      .add(0.925);
    const shellTone = haloColors[index]!;
    shellMaterial.colorNode = vec3(shellTone.r, shellTone.g, shellTone.b)
      .mul(radiances[index]!)
      .mul(limb.mul(0.54).add(0.65))
      .mul(magneticThreads);
    shellMaterial.opacityNode = limb.pow(0.75 + index * 0.21)
      .mul(0.69)
      .add(0.31)
      .mul(opacities[index]!);
    shellMaterial.userData.hdrRadiance = radiances[index];
    shellMaterial.userData.chromaticCorona = true;
    shellMaterial.userData.physicalMagneticThreads = true;
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius * scales[index]!, index === 0 ? 2 : 1),
      shellMaterial,
    );
    shell.name = `Physical stellar corona / shell ${index + 1}`;
    shell.renderOrder = 6 + index;
    group.add(shell);
  }

  // A camera-facing scattering halo stays centered on this exact physical
  // stellar body. It does not enlarge the core, navigation target, or the
  // simulation's authoritative heat/exclusion radius.
  const atmosphericScattering = uniform(0);
  const starColor = uniform(tone.clone().lerp(white, 0.055));
  const spectralCoronaColor = uniform(radiantSpectrum);
  const hotPhotosphere = uniform(radiantSpectrum.clone().lerp(new THREE.Color('#FFF1AE'), 0.44));
  const outerCorona = uniform(radiantSpectrum.clone().lerp(new THREE.Color(PALETTE.sunRed), 0.1));
  const haloUV = uv().sub(0.5).mul(2);
  const radial = haloUV.length();
  const boundary = radial.smoothstep(0.56, 1).oneMinus();
  // The sprite may expand through real atmosphere, but its luminous optical
  // disc must stay compact: compensate that scale inside the same six draws.
  const opticalUV = haloUV.mul(atmosphericScattering.mul(1.12).add(1));
  const opticalRadius = opticalUV.length();
  const photosphere = opticalRadius.smoothstep(0.105, 0.37).oneMinus();
  const chromosphere = opticalRadius.smoothstep(0.2, 0.57).oneMinus();
  const innerCorona = opticalRadius.mul(opticalRadius).mul(-6.8).exp();
  const corona = opticalRadius.mul(opticalRadius).mul(-12).exp();
  const sunsetHalo = opticalRadius.mul(opticalRadius)
    .mul(atmosphericScattering.mul(0.45).sub(12.4))
    .exp();
  const horizontalSpoke = opticalUV.y.abs().mul(-52).exp()
    .mul(opticalUV.x.abs().mul(-4.5).exp());
  const verticalSpoke = opticalUV.x.abs().mul(-52).exp()
    .mul(opticalUV.y.abs().mul(-4.5).exp());
  const risingSpoke = opticalUV.x.sub(opticalUV.y).abs().mul(-42).exp()
    .mul(opticalRadius.mul(-6.4).exp());
  const fallingSpoke = opticalUV.x.add(opticalUV.y).abs().mul(-42).exp()
    .mul(opticalRadius.mul(-6.4).exp());
  const spokes = horizontalSpoke.add(verticalSpoke)
    .add(risingSpoke.add(fallingSpoke).mul(0.67))
    .mul(opticalRadius.smoothstep(0.07, 0.19));
  const haloOpacity = photosphere.mul(0.74)
    .add(chromosphere.mul(0.64))
    .add(innerCorona.mul(atmosphericScattering.mul(-0.09).add(0.33)))
    .add(corona.mul(0.065))
    .add(sunsetHalo.mul(atmosphericScattering.mul(0.012).add(0.014)))
    .add(spokes.mul(0.115))
    .mul(boundary)
    .min(0.98);
  const spectralCorona = mix(outerCorona, spectralCoronaColor, chromosphere.mul(0.82).add(0.18).min(1));
  const haloColor = mix(spectralCorona, hotPhotosphere, photosphere.mul(0.64))
    .mul(photosphere.mul(1.95)
      .add(chromosphere.mul(1.55))
      .add(innerCorona.mul(0.62))
      .add(corona.mul(0.13))
      .add(spokes.mul(0.12))
      .add(0.61));
  const haloMaterial = new THREE.SpriteNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
    alphaTest: 0.005,
    toneMapped: false,
    fog: false,
  });
  haloMaterial.scaleNode = atmosphericScattering.mul(1.35).add(1);
  haloMaterial.colorNode = haloColor;
  haloMaterial.opacityNode = haloOpacity;
  haloMaterial.userData.starColor = starColor;
  haloMaterial.userData.atmosphericScattering = atmosphericScattering;
  haloMaterial.userData.hdrRadiance = 4.86;
  haloMaterial.userData.chromaticCorona = true;
  haloMaterial.userData.diffractionRayCount = 8;
  haloMaterial.userData.spectralChromosphereColor = radiantSpectrum.getHexString();
  haloMaterial.userData.opticalPhotosphereRadiusMultiplier = 3.48;
  haloMaterial.userData.opticalChromosphereRadiusMultiplier = 5.36;
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 18.8, radius * 18.8),
    haloMaterial,
  );
  halo.name = 'Actual stellar body / bounded camera-facing scattering halo';
  halo.frustumCulled = false;
  halo.renderOrder = 10;
  group.add(halo);

  group.userData.physicalRadius = radius;
  group.userData.scatteringRadius = radius * 9.4;
  group.userData.maximumAtmosphericScatteringRadius = radius * 9.4 * 2.35;
  group.userData.photosphereRadiance = photosphereRadiance;
  group.userData.segmentedPhotosphere = true;
  group.userData.chromaticCorona = true;
  group.userData.diffractionRayCount = 8;
  group.userData.physicalStellarDraws = 6;
  group.userData.spectralColor = tone.getHexString();
  group.userData.spectralChromosphereColor = radiantSpectrum.getHexString();
  group.userData.opticalPhotosphereRadiusMultiplier = 3.48;
  group.userData.opticalChromosphereRadiusMultiplier = 5.36;
  group.userData.atmosphericScattering = atmosphericScattering;
  group.userData.setAtmosphericScattering = (density: number): void => {
    atmosphericScattering.value = THREE.MathUtils.clamp(density, 0, 1);
  };
  return group;
}
