import * as THREE from 'three';
import {
  type Node,
  RenderPipeline,
  RenderTarget,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  float,
  mix,
  NodeUpdateType,
  renderOutput,
  rtt,
  smoothstep,
  texture,
  toneMapping,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom, type default as BloomNode } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import type { CelestialLightFrame } from '../../lighting';
import { resolveSceneTargetAntialiasing, supportsSceneHalfFloat } from '../RendererHost';
import {
  ExposureController,
  type ProjectedCelestialSource,
} from './ExposureController';
import {
  DEFAULT_NEON_PHOSPHOR_MODE,
  PHOSPHOR_EDGE_LIMITS,
  resolveNeonPhosphorSettings,
  type NeonPhosphorMode,
  type NeonPhosphorSettings,
} from './NeonPhosphor';

export type { ProjectedCelestialSource } from './ExposureController';

export type NeonPostQuality = 'high' | 'fallback';
export type NeonSpatialAntialiasing = 'none' | 'smaa';

export interface NeonPostOptions {
  /** Spatial presentation AA; native scene MSAA remains independently active. */
  readonly spatialAntialiasing?: NeonSpatialAntialiasing;
}

const NEON_CHROMA_START = 0.22;
const NEON_CHROMA_FULL = 0.68;
const NEON_BRIGHTNESS_START = 0.18;
const NEON_BRIGHTNESS_FULL = 0.72;
const EMITTER_CHROMA_START = 0.19;
const EMITTER_CHROMA_FULL = 0.72;
const EMITTER_LUMINANCE_START = 0.46;
const EMITTER_LUMINANCE_FULL = 1.32;
const EMITTER_LOCAL_CONTRAST_START = 0.018;
const EMITTER_LOCAL_CONTRAST_FULL = 0.19;
const EMITTER_HDR_START = 1.08;
const EMITTER_HDR_FULL = 2.15;
const STELLAR_RADIANCE_START = 1.34;
const STELLAR_RADIANCE_FULL = 3.05;
const STELLAR_SELF_LUMINOUS_START = 2.16;
const STELLAR_SELF_LUMINOUS_FULL = 3.5;
const STELLAR_BLOOM_GAIN = 1.82;
const STELLAR_FALLBACK_GAIN = 1.32;
const HIGHLIGHT_SHOULDER_START = 0.56;
const HIGHLIGHT_SHOULDER_FULL = 1.34;
const HIGHLIGHT_SHOULDER_STRENGTH = 0.34;
const HDR_BLOOM_MIPS = 5;
const HDR_BLOOM_PASSES = 2 + HDR_BLOOM_MIPS * 2;
const SMAA_PRESENTATION_PASSES = 4;

/** CPU mirror of the actual TSL composite's saturated-emitter protection. */
export function neonPreservationWeight(color: THREE.Color): number {
  const strongest = Math.max(color.r, color.g, color.b);
  const weakest = Math.min(color.r, color.g, color.b);
  const chroma = (strongest - weakest) / Math.max(strongest, 0.000_01);
  return THREE.MathUtils.smoothstep(chroma, NEON_CHROMA_START, NEON_CHROMA_FULL) *
    THREE.MathUtils.smoothstep(strongest, NEON_BRIGHTNESS_START, NEON_BRIGHTNESS_FULL);
}

/** Spatially flat colored planet/ocean facets are not self-emitting lights. */
export function neonEmitterWeight(color: THREE.Color, adjacentColor: THREE.Color): number {
  const strongest = Math.max(color.r, color.g, color.b);
  const weakest = Math.min(color.r, color.g, color.b);
  const chroma = (strongest - weakest) / Math.max(strongest, 0.000_01);
  const localContrast = Math.max(
    Math.abs(color.r - adjacentColor.r),
    Math.abs(color.g - adjacentColor.g),
    Math.abs(color.b - adjacentColor.b),
  );
  const colorGate = THREE.MathUtils.smoothstep(chroma, EMITTER_CHROMA_START, EMITTER_CHROMA_FULL);
  const brightnessGate = THREE.MathUtils.smoothstep(
    strongest,
    EMITTER_LUMINANCE_START,
    EMITTER_LUMINANCE_FULL,
  );
  const contrastGate = THREE.MathUtils.smoothstep(
    localContrast,
    EMITTER_LOCAL_CONTRAST_START,
    EMITTER_LOCAL_CONTRAST_FULL,
  );
  const genuineHdr = THREE.MathUtils.smoothstep(strongest, EMITTER_HDR_START, EMITTER_HDR_FULL);
  const chromaticEmitter = colorGate * brightnessGate * Math.max(contrastGate, genuineHdr * 0.88);
  return Math.max(chromaticEmitter, stellarRadianceWeight(color, adjacentColor));
}

/** Genuine HDR photospheres may be nearly white while ordinary lit terrain is not a star. */
export function stellarRadianceWeight(color: THREE.Color, adjacentColor: THREE.Color): number {
  const strongest = Math.max(color.r, color.g, color.b);
  const localContrast = Math.max(
    Math.abs(color.r - adjacentColor.r),
    Math.abs(color.g - adjacentColor.g),
    Math.abs(color.b - adjacentColor.b),
  );
  const stellarEnergy = THREE.MathUtils.smoothstep(
    strongest,
    STELLAR_RADIANCE_START,
    STELLAR_RADIANCE_FULL,
  );
  const isolatedPhotosphere = THREE.MathUtils.smoothstep(
    localContrast,
    EMITTER_LOCAL_CONTRAST_START,
    EMITTER_LOCAL_CONTRAST_FULL,
  );
  const selfLuminousCore = THREE.MathUtils.smoothstep(
    strongest,
    STELLAR_SELF_LUMINOUS_START,
    STELLAR_SELF_LUMINOUS_FULL,
  );
  return stellarEnergy * Math.max(isolatedPhotosphere, selfLuminousCore * 0.92);
}

/** One luminance-only shoulder retains the actual linear hue of bright surfaces. */
export function neonHighlightCompression(color: THREE.Color, emitterWeight = 0): THREE.Color {
  const luminance = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  const shoulder = THREE.MathUtils.smoothstep(
    luminance,
    HIGHLIGHT_SHOULDER_START,
    HIGHLIGHT_SHOULDER_FULL,
  );
  const excess = Math.max(0, luminance - HIGHLIGHT_SHOULDER_START);
  const protectedAccent = THREE.MathUtils.clamp(emitterWeight, 0, 1) * 0.82;
  const scale = 1 / (1 + excess * shoulder * HIGHLIGHT_SHOULDER_STRENGTH * (1 - protectedAccent));
  return color.clone().multiplyScalar(scale);
}

export interface NeonPostSettings {
  readonly quality: NeonPostQuality;
  readonly sharpenStrength: number;
  readonly glowStrength: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly vignette: number;
  readonly bloomThreshold: number;
  readonly bloomRadius: number;
  readonly bloomResolutionScale: number;
  readonly emitterContrastStart: number;
  readonly emitterContrastFull: number;
  readonly emitterHdrStart: number;
  readonly stellarRadianceStart: number;
  readonly stellarRadianceFull: number;
  readonly stellarBloomGain: number;
  readonly highlightShoulderStart: number;
  readonly highlightShoulderStrength: number;
}

/** Only operations used by both initialized WebGPU and its real WebGL backend. */
export interface NeonPostRenderer {
  autoClear: boolean;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  outputColorSpace: string;
  xr: { enabled: boolean };
  info: {
    autoReset: boolean;
    reset: () => void;
    render: { calls: number; triangles: number; drawCalls?: number };
  };
  backend?: object;
  getDrawingBufferSize(destination: THREE.Vector2): THREE.Vector2;
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(target: THREE.RenderTarget | null): void;
  clearDepth(): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

/**
 * True linear HDR world + opaque ship, followed by a backend-native TSL graph.
 *
 * High quality uses five half-float bloom mips and can add stock SMAA before
 * the CRT treatment. Explicit fallback retains the same physically opaque
 * scene composite and a crisp single TSL presentation pass. ACES and output
 * conversion each run exactly once; colored emitters are protected before
 * the sole linear-to-sRGB output transform.
 */
export class NeonPostProcess {
  readonly active = true;
  readonly settings: NeonPostSettings;
  readonly target: THREE.RenderTarget;
  readonly pipeline: RenderPipeline;
  readonly bloomNode?: BloomNode;
  /** Real pre-CRT, tone-mapped linear input and the official three-pass SMAA node. */
  readonly smaaInputNode?: ReturnType<typeof rtt>;
  readonly smaaNode?: ReturnType<typeof smaa>;
  readonly exposureController: ExposureController;
  readonly userData: {
    readonly active: true;
    readonly passes: number;
    readonly bloomPasses: number;
    readonly bloomMips: number;
    readonly selectiveNeonGlow: true;
    readonly edgeLimitedSharpen: true;
    readonly huePreservingToneMapping: true;
    readonly localizedBloom: true;
    readonly highlightShoulder: true;
    readonly huePreservingHighlights: true;
    readonly stellarHdrBloom: true;
    readonly stellarSpectralHighlights: true;
    readonly adaptiveExposure: true;
    readonly physicalCelestialOptics: true;
    readonly maximumCelestialOpticalSources: 3;
    readonly opticalGhostsPerActualStar: 1;
    readonly neonPhosphor: true;
    readonly orderedDither: true;
    readonly screenLockedPattern: true;
    readonly emitterHueProtection: true;
    readonly nativeUiUnfiltered: true;
    readonly samePassPhosphor: true;
    /** Genuine color/depth coverage samples on the world-and-ship target. */
    readonly sceneSamples: 0 | 2 | 4;
    readonly requestedSamples: 4;
    readonly antialiasing: 'msaa' | 'edge-filter';
    readonly antialiasingReason?: string;
    readonly requestedSpatialAntialiasing: NeonSpatialAntialiasing;
    readonly spatialAntialiasing: NeonSpatialAntialiasing;
    readonly spatialAntialiasingPasses: 0 | 4;
    readonly spatialAntialiasingReason?: string;
    readonly coverageAwarePresentation: true;
    readonly hdr: boolean;
    readonly precision: 'rgba16f' | 'rgba8';
    readonly nodePipeline: true;
    readonly colorTransforms: 1;
    readonly quality: NeonPostQuality;
  };

  private readonly renderer: NeonPostRenderer;
  private readonly drawingBuffer = new THREE.Vector2();
  private readonly texelSize;
  private readonly exposure;
  private readonly phosphorGrading;
  private readonly phosphorTexture;
  private readonly phosphorProtection;
  private readonly presentationControls;
  private currentPhosphorSettings: Readonly<NeonPhosphorSettings>;
  private readonly celestialOptics = Array.from({ length: 3 }, () => ({
    position: uniform(new THREE.Vector2(0.5, 0.5)),
    color: uniform(new THREE.Color(0, 0, 0)),
    state: uniform(new THREE.Vector4(0.001, 0, 0, 0)),
  }));
  private disposed = false;

  constructor(
    renderer: NeonPostRenderer,
    quality: NeonPostQuality = 'high',
    options: NeonPostOptions = {},
  ) {
    this.renderer = renderer;
    this.exposureController = new ExposureController(renderer.toneMappingExposure ?? 1);
    this.currentPhosphorSettings = resolveNeonPhosphorSettings(DEFAULT_NEON_PHOSPHOR_MODE, quality);
    const floatingPoint = supportsSceneHalfFloat(renderer.backend);
    const antialiasing = resolveSceneTargetAntialiasing(
      renderer.backend,
      floatingPoint ? 'rgba16f' : 'rgba8',
    );
    const fullBloom = quality === 'high' && floatingPoint;
    const requestedSpatialAntialiasing = options.spatialAntialiasing ?? 'none';
    const useSmaa = requestedSpatialAntialiasing === 'smaa' && quality === 'high' && floatingPoint;
    const spatialAntialiasingReason = requestedSpatialAntialiasing === 'smaa' && !useSmaa
      ? (quality !== 'high'
        ? 'SMAA is reserved for the High graphics tier'
        : 'SMAA requires renderable half-float color targets')
      : undefined;
    this.settings = Object.freeze({
      quality,
      // A resolved partial-coverage edge is useful image information. Strong
      // unsharp masking would turn it back into a dotted black panel line.
      sharpenStrength: antialiasing.samples > 0
        ? (quality === 'high' ? 0.085 : 0.065)
        : (quality === 'high' ? 0.07 : 0.05),
      glowStrength: fullBloom ? 0.36 : 0.082,
      contrast: quality === 'high' ? 1.1 : 1.065,
      saturation: quality === 'high' ? 1.13 : 1.085,
      vignette: quality === 'high' ? 0.082 : 0.06,
      bloomThreshold: 0.43,
      bloomRadius: 0.57,
      bloomResolutionScale: 0.5,
      emitterContrastStart: EMITTER_LOCAL_CONTRAST_START,
      emitterContrastFull: EMITTER_LOCAL_CONTRAST_FULL,
      emitterHdrStart: EMITTER_HDR_START,
      stellarRadianceStart: STELLAR_RADIANCE_START,
      stellarRadianceFull: STELLAR_RADIANCE_FULL,
      stellarBloomGain: fullBloom ? STELLAR_BLOOM_GAIN : STELLAR_FALLBACK_GAIN,
      highlightShoulderStart: HIGHLIGHT_SHOULDER_START,
      highlightShoulderStrength: HIGHLIGHT_SHOULDER_STRENGTH,
    });
    this.userData = Object.freeze({
      active: true,
      passes: (fullBloom ? HDR_BLOOM_PASSES + 1 : 1) + (useSmaa ? SMAA_PRESENTATION_PASSES : 0),
      bloomPasses: fullBloom ? HDR_BLOOM_PASSES : 0,
      bloomMips: fullBloom ? HDR_BLOOM_MIPS : 0,
      selectiveNeonGlow: true,
      edgeLimitedSharpen: true,
      huePreservingToneMapping: true,
      localizedBloom: true,
      highlightShoulder: true,
      huePreservingHighlights: true,
      stellarHdrBloom: true,
      stellarSpectralHighlights: true,
      adaptiveExposure: true,
      physicalCelestialOptics: true,
      maximumCelestialOpticalSources: 3,
      opticalGhostsPerActualStar: 1,
      neonPhosphor: true,
      orderedDither: true,
      screenLockedPattern: true,
      emitterHueProtection: true,
      nativeUiUnfiltered: true,
      samePassPhosphor: true,
      sceneSamples: antialiasing.samples,
      requestedSamples: antialiasing.requestedSamples,
      antialiasing: antialiasing.samples > 0 ? 'msaa' : 'edge-filter',
      ...(antialiasing.reason ? { antialiasingReason: antialiasing.reason } : {}),
      requestedSpatialAntialiasing,
      spatialAntialiasing: useSmaa ? 'smaa' : 'none',
      spatialAntialiasingPasses: useSmaa ? SMAA_PRESENTATION_PASSES : 0,
      ...(spatialAntialiasingReason ? { spatialAntialiasingReason } : {}),
      coverageAwarePresentation: true,
      hdr: floatingPoint,
      precision: floatingPoint ? 'rgba16f' : 'rgba8',
      nodePipeline: true,
      colorTransforms: 1,
      quality,
    });

    renderer.getDrawingBufferSize(this.drawingBuffer);
    const width = Math.max(1, Math.round(this.drawingBuffer.x));
    const height = Math.max(1, Math.round(this.drawingBuffer.y));
    this.target = new RenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      // The world and foreground each use the real multisample depth buffer.
      // No later pass samples depth, so avoid a needless/format-sensitive
      // single-sample depth resolve while retaining logarithmic depth testing.
      resolveDepthBuffer: false,
      resolveStencilBuffer: false,
      samples: antialiasing.samples,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: floatingPoint ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    this.target.texture.name = floatingPoint
      ? 'Linear RGBA16F real universe and opaque foreground spacecraft'
      : 'Linear compatibility universe and opaque foreground spacecraft';

    this.texelSize = uniform(new THREE.Vector2(1 / width, 1 / height));
    this.exposure = uniform(this.exposureController.value);
    this.phosphorGrading = uniform(new THREE.Vector4(
      this.currentPhosphorSettings.intensity,
      this.currentPhosphorSettings.paletteLevels,
      this.currentPhosphorSettings.ditherStrength,
      this.currentPhosphorSettings.scanlineStrength,
    ));
    this.phosphorTexture = uniform(new THREE.Vector4(
      this.currentPhosphorSettings.phosphorStrength,
      this.currentPhosphorSettings.phosphorPitchPixels,
      this.currentPhosphorSettings.horizontalBleedStrength,
      this.currentPhosphorSettings.scanlinePitchPixels,
    ));
    this.phosphorProtection = uniform(new THREE.Vector4(
      this.currentPhosphorSettings.blackFloor,
      this.currentPhosphorSettings.blackFeather,
      this.currentPhosphorSettings.highlightProtection,
      this.currentPhosphorSettings.enabled ? 1 : 0,
    ));
    this.presentationControls = uniform(new THREE.Vector2(
      this.currentPhosphorSettings.sharpenScale,
      this.currentPhosphorSettings.contrastScale,
    ));

    const coordinate = uv();
    const source = texture(this.target.texture, coordinate);
    const center = source.rgb;
    const horizontalStep = vec2(this.texelSize.x, float(0));
    const verticalStep = vec2(float(0), this.texelSize.y);
    const left = texture(this.target.texture, coordinate.sub(horizontalStep)).rgb;
    const right = texture(this.target.texture, coordinate.add(horizontalStep)).rgb;
    const bottom = texture(this.target.texture, coordinate.sub(verticalStep)).rgb;
    const top = texture(this.target.texture, coordinate.add(verticalStep)).rgb;
    const neighborhood = left.add(right).add(bottom).add(top).mul(0.25);
    const luminanceAxis = vec3(0.2126, 0.7152, 0.0722);
    const centerEdgeLuminance = center.dot(luminanceAxis);
    const leftLuminance = left.dot(luminanceAxis);
    const rightLuminance = right.dot(luminanceAxis);
    const bottomLuminance = bottom.dot(luminanceAxis);
    const topLuminance = top.dot(luminanceAxis);
    const minimumLuminance = centerEdgeLuminance.min(leftLuminance).min(rightLuminance)
      .min(bottomLuminance).min(topLuminance);
    const maximumLuminance = centerEdgeLuminance.max(leftLuminance).max(rightLuminance)
      .max(bottomLuminance).max(topLuminance);
    const luminanceRange = maximumLuminance.sub(minimumLuminance);
    const absoluteEdge = smoothstep(
      PHOSPHOR_EDGE_LIMITS.absoluteStart,
      PHOSPHOR_EDGE_LIMITS.absoluteFull,
      luminanceRange,
    );
    const relativeEdge = smoothstep(
      PHOSPHOR_EDGE_LIMITS.relativeStart,
      PHOSPHOR_EDGE_LIMITS.relativeFull,
      luminanceRange.div(maximumLuminance.max(PHOSPHOR_EDGE_LIMITS.luminanceFloor)),
    ).mul(smoothstep(PHOSPHOR_EDGE_LIMITS.detailStart, PHOSPHOR_EDGE_LIMITS.detailFull, luminanceRange));
    // Unlike the former 8% floor, this is exactly zero on a real fine edge.
    // The same measured coverage protects sharpening and every CRT pattern.
    const coverageProtection = float(1).sub(absoluteEdge.max(relativeEdge));

    let coveredCenter = center;
    if (antialiasing.samples === 0) {
      // A format-limited device still gets a bounded spatial AA fallback.
      // Reuse the existing five taps and touch only high-contrast subpixel
      // edges; broad faceted surfaces and the native-resolution HUD stay sharp.
      const horizontalVariation = leftLuminance.sub(centerEdgeLuminance).abs()
        .add(rightLuminance.sub(centerEdgeLuminance).abs());
      const verticalVariation = bottomLuminance.sub(centerEdgeLuminance).abs()
        .add(topLuminance.sub(centerEdgeLuminance).abs());
      const horizontalWeight = smoothstep(-0.08, 0.08, horizontalVariation.sub(verticalVariation));
      const alongGradient = mix(bottom.add(top).mul(0.5), left.add(right).mul(0.5), horizontalWeight);
      const relativeEdge = luminanceRange.div(maximumLuminance.max(0.08));
      const subpixelContrast = centerEdgeLuminance.sub(neighborhood.dot(luminanceAxis)).abs()
        .div(luminanceRange.max(0.0001));
      const edgeBlend = smoothstep(0.08, 0.36, relativeEdge)
        .mul(smoothstep(0.06, 0.42, subpixelContrast)).mul(0.28);
      coveredCenter = mix(center, alongGradient, edgeBlend);
    }

    const detail = coveredCenter.sub(neighborhood);
    const strongestEdge = detail.abs().r.max(detail.abs().g).max(detail.abs().b);
    const edgeLimiter = float(1).sub(smoothstep(0.08, 0.38, strongestEdge).mul(0.93));
    let graded = coveredCenter.add(detail.mul(this.settings.sharpenStrength)
      .mul(this.presentationControls.x).clamp(-0.025, 0.025)
      .mul(edgeLimiter).mul(coverageProtection)).max(vec3(0));

    const centerStrongest = center.r.max(center.g).max(center.b);
    const centerWeakest = center.r.min(center.g).min(center.b);
    const centerChroma = centerStrongest.sub(centerWeakest).div(centerStrongest.max(0.000_01));
    const emissiveColor = smoothstep(EMITTER_CHROMA_START, EMITTER_CHROMA_FULL, centerChroma);
    const emissiveBrightness = smoothstep(
      EMITTER_LUMINANCE_START,
      EMITTER_LUMINANCE_FULL,
      centerStrongest,
    );
    const emitterLocalContrast = smoothstep(
      EMITTER_LOCAL_CONTRAST_START,
      EMITTER_LOCAL_CONTRAST_FULL,
      strongestEdge,
    );
    const genuineHdrEmitter = smoothstep(EMITTER_HDR_START, EMITTER_HDR_FULL, centerStrongest);
    const emitterIsolation = emitterLocalContrast.max(genuineHdrEmitter.mul(0.88));
    const chromaticEmitter = emissiveColor.mul(emissiveBrightness).mul(emitterIsolation);
    // Real stellar photospheres are frequently hot white or warm near-white.
    // Their measured linear HDR energy, not chroma, proves they are emitters;
    // flat normally lit planets remain excluded below the self-luminous gate.
    const stellarEnergy = smoothstep(STELLAR_RADIANCE_START, STELLAR_RADIANCE_FULL, centerStrongest);
    const selfLuminousCore = smoothstep(
      STELLAR_SELF_LUMINOUS_START,
      STELLAR_SELF_LUMINOUS_FULL,
      centerStrongest,
    );
    const stellarEmitter = stellarEnergy.mul(emitterLocalContrast.max(selfLuminousCore.mul(0.92)));
    const emitterWeight = chromaticEmitter.max(stellarEmitter);
    const stellarBloomBoost = float(1).add(stellarEmitter.mul(this.settings.stellarBloomGain - 1));
    // Broad teal oceans, purple skies, and lit planet faces retain their
    // authored facets; only true compact/high-energy emitters enter bloom.
    const selectiveSource = vec4(center.mul(emitterWeight).mul(stellarBloomBoost), 1);

    // Optical phenomena are camera responses to projected, physically existing
    // suns. Sampling their actual final HDR pixel suppresses the complete effect
    // behind a real planet, cloud bank, or the genuinely opaque spacecraft.
    const viewportAspect = this.texelSize.y.div(this.texelSize.x.max(0.000_01));
    let actualStellarVicinity: Node<'float'> = float(0);
    let actualStellarOptics: Node<'vec3'> = vec3(0);
    // Every real sun keeps its physical photosphere/corona meshes. WebGL adds
    // camera-lens optics only for the brightest visible source, avoiding extra
    // full-frame texture fetches and preserving genuinely occluded starlight.
    const visibleOpticalSlots = fullBloom
      ? this.celestialOptics
      : this.celestialOptics.slice(0, 1);
    for (const optic of visibleOpticalSlots) {
      const starSample = texture(this.target.texture, optic.position).rgb;
      const sampleStrongest = starSample.r.max(starSample.g).max(starSample.b);

      if (!fullBloom) {
        const visibility = optic.state.y.mul(smoothstep(0.92, 2.05, sampleStrongest));
        const radius = optic.state.x.max(0.001).min(0.05);
        const offset = coordinate.sub(optic.position);
        const corrected = vec2(offset.x.mul(viewportAspect), offset.y);
        const distanceSquared = corrected.dot(corrected);
        const haloRadius = radius.mul(7.4).add(0.006).min(0.13);
        const halo = float(1).sub(
          distanceSquared.div(haloRadius.mul(haloRadius).max(0.000_001)),
        ).max(0);
        const radiance = halo.mul(halo).mul(visibility).mul(optic.state.z).mul(0.072);
        actualStellarOptics = actualStellarOptics.add(optic.color.mul(radiance));

        const ghostPosition = vec2(0.5, 0.5)
          .sub(optic.position.sub(vec2(0.5, 0.5)).mul(0.54));
        const ghostOffset = coordinate.sub(ghostPosition);
        const correctedGhost = vec2(ghostOffset.x.mul(viewportAspect), ghostOffset.y);
        const ghostDistanceSquared = correctedGhost.dot(correctedGhost);
        const ghostRadius = radius.mul(0.66).add(0.013).min(0.033);
        const ghost = float(1).sub(
          ghostDistanceSquared.div(ghostRadius.mul(ghostRadius).max(0.000_001)),
        ).max(0);
        const reflection = ghost.mul(ghost).mul(visibility).mul(optic.state.z).mul(0.014);
        actualStellarOptics = actualStellarOptics.add(optic.color.mul(reflection));
        continue;
      }

      const expectedStrongest = optic.color.r.max(optic.color.g).max(optic.color.b);
      const sampleSpectrum = starSample.div(sampleStrongest.max(0.000_01));
      const expectedSpectrum = optic.color.div(expectedStrongest.max(0.000_01));
      const spectralDifference = sampleSpectrum.sub(expectedSpectrum).abs();
      const spectralMismatch = spectralDifference.r.max(spectralDifference.g)
        .max(spectralDifference.b);
      const actualPhotosphere = smoothstep(0.92, 2.05, sampleStrongest)
        .mul(float(1).sub(smoothstep(0.37, 0.82, spectralMismatch)));
      const visibility = optic.state.y.mul(actualPhotosphere);
      const radius = optic.state.x.max(0.001).min(0.05);
      const offset = coordinate.sub(optic.position);
      const corrected = vec2(offset.x.mul(viewportAspect), offset.y);
      const distance = corrected.length();
      const haloRadius = radius.mul(8.1).add(0.007).min(0.15);
      const boundary = float(1).sub(smoothstep(haloRadius.mul(0.66), haloRadius, distance));
      const sourceRegion = boundary.mul(visibility);
      actualStellarVicinity = actualStellarVicinity.max(sourceRegion);

      const falloff = distance.div(radius.mul(2.45).add(0.002)).negate().exp();
      const horizontal = corrected.y.abs().div(radius.mul(0.17).add(0.0009))
        .negate().exp().mul(corrected.x.abs().div(haloRadius.mul(0.71)).negate().exp());
      const vertical = corrected.x.abs().div(radius.mul(0.17).add(0.0009))
        .negate().exp().mul(corrected.y.abs().div(haloRadius.mul(0.71)).negate().exp());
      const diffraction = horizontal.add(vertical).mul(
        float(1).sub(optic.state.w.mul(0.42)),
      );
      const radiance = falloff.mul(0.085).add(diffraction.mul(0.031))
        .mul(sourceRegion).mul(optic.state.z);
      actualStellarOptics = actualStellarOptics.add(optic.color.mul(radiance));

      // One deliberately soft internal reflection is a lens artifact of this
      // same star, never a catalog object or an independently targetable point.
      const ghostPosition = vec2(0.5, 0.5)
        .sub(optic.position.sub(vec2(0.5, 0.5)).mul(0.54));
      const ghostOffset = coordinate.sub(ghostPosition);
      const ghostDistance = vec2(ghostOffset.x.mul(viewportAspect), ghostOffset.y).length();
      const ghostRadius = radius.mul(0.66).add(0.013).min(0.033);
      const ghostBoundary = float(1).sub(
        smoothstep(ghostRadius.mul(0.3), ghostRadius, ghostDistance),
      );
      const lensReflection = ghostBoundary.mul(visibility).mul(optic.state.z).mul(0.016);
      actualStellarOptics = actualStellarOptics.add(optic.color.mul(lensReflection));
    }

    if (fullBloom) {
      const multiScale = bloom(
        selectiveSource,
        this.settings.glowStrength,
        this.settings.bloomRadius,
        this.settings.bloomThreshold,
      );
      multiScale.setResolutionScale(this.settings.bloomResolutionScale);
      this.bloomNode = multiScale;

      // True empty pixels stay black: long-radius energy cannot wash the void.
      const nearbyPresence = centerStrongest.max(neighborhood.r.max(neighborhood.g).max(neighborhood.b));
      const physicalEmitterVicinity = smoothstep(0.004, 0.09, nearbyPresence);
      graded = graded.add(multiScale.rgb.mul(
        physicalEmitterVicinity.max(actualStellarVicinity.mul(0.8)),
      ));
    } else {
      // Forced compatibility mode never runs the expensive eleven blur draws.
      graded = graded.add(
        neighborhood.mul(emitterWeight).mul(this.settings.glowStrength).mul(stellarBloomBoost),
      );
    }
    graded = graded.add(actualStellarOptics);

    // Compress only genuine bright broad surfaces by one common scalar. This
    // maintains physical channel ratios and leaves real emitters nearly alone.
    const surfaceLuminance = graded.dot(vec3(0.2126, 0.7152, 0.0722));
    const highlightGate = smoothstep(
      HIGHLIGHT_SHOULDER_START,
      HIGHLIGHT_SHOULDER_FULL,
      surfaceLuminance,
    );
    const highlightExcess = surfaceLuminance.sub(HIGHLIGHT_SHOULDER_START).max(0);
    const highlightScale = float(1).div(float(1).add(
      highlightExcess.mul(highlightGate).mul(HIGHLIGHT_SHOULDER_STRENGTH)
        .mul(float(1).sub(emitterWeight.mul(0.82))),
    ));
    graded = graded.mul(highlightScale);

    const luminance = graded.dot(vec3(0.2126, 0.7152, 0.0722));
    const accent = smoothstep(0.12, 0.58, centerChroma);
    graded = mix(vec3(luminance), graded,
      mix(float(1).add(float(this.settings.saturation - 1).mul(0.5)),
        float(this.settings.saturation), accent));
    const contrast = float(1).add(this.presentationControls.y.mul(this.settings.contrast - 1));
    graded = graded.sub(vec3(0.18)).mul(contrast).add(vec3(0.18)).max(vec3(0));
    const shadowToe = smoothstep(0.012, 0.16, luminance);
    graded = graded.mul(mix(float(0.69), float(1), shadowToe.max(accent.mul(0.82))));

    const centered = coordinate.mul(2).sub(vec2(1));
    const corners = smoothstep(0.45, 1.7, centered.dot(centered));
    graded = graded.mul(float(1).sub(corners.mul(this.settings.vignette)));

    // Only neutral/highlight surfaces receive ACES. Saturated actual engines,
    // rings, geological seams, and suns retain their original electric hue.
    const filmic = toneMapping(
      renderer.toneMapping ?? THREE.ACESFilmicToneMapping,
      this.exposure,
      vec4(graded, 1),
    ).rgb;
    const protectedStrongest = graded.r.max(graded.g).max(graded.b);
    const protectedWeakest = graded.r.min(graded.g).min(graded.b);
    const protectedChroma = protectedStrongest.sub(protectedWeakest)
      .div(protectedStrongest.max(0.000_01));
    const chromaticAccent = smoothstep(NEON_CHROMA_START, NEON_CHROMA_FULL, protectedChroma)
      .mul(smoothstep(NEON_BRIGHTNESS_START, NEON_BRIGHTNESS_FULL, protectedStrongest));
    const protectedAccent = chromaticAccent.max(stellarEmitter.mul(0.9));
    // Uniform max-channel normalization avoids independently clipping cyan,
    // magenta, or amber into flat white while preserving their original hue.
    const preservedEmitter = graded.div(protectedStrongest.max(1));
    let finalLinear: Node<'vec3'> = mix(filmic, preservedEmitter, protectedAccent);

    if (useSmaa) {
      // Stock r185 SMAA expects linear color before the output conversion.
      // Materialize our already tone-mapped, hue-preserved scene once, then
      // apply the intentional screen-locked CRT texture only after AA.
      const input = rtt(vec4(finalLinear, 1), null, null, {
        depthBuffer: false,
        stencilBuffer: false,
        samples: 0,
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      });
      // SMAA samples the input in its edge and blend passes. The immutable
      // scene color must not be rendered again for each of those draws.
      input.updateBeforeType = NodeUpdateType.FRAME;
      input.setSize(width, height);
      if (input.renderTarget) input.renderTarget.texture.name = 'Tone-mapped linear scene before SMAA and CRT';
      this.smaaInputNode = input;
      this.smaaNode = smaa(input);
      this.smaaNode.setSize(width, height);
      finalLinear = this.smaaNode.getTextureNode().rgb;
    }

    // A restrained phosphor display belongs in this existing presentation
    // shader. Coordinates follow actual internal framebuffer pixels, not
    // world/simulation time; resized texelSize keeps the matrix screen locked.
    const screenPixel = coordinate.div(this.texelSize).floor();
    const lowX = screenPixel.x.mod(2);
    const lowY = screenPixel.y.mod(2);
    const lowBayerRank = lowX.mul(2).add(lowY.mul(3)).sub(lowX.mul(lowY).mul(4));
    let orderedThreshold: Node<'float'>;
    if (quality === 'fallback') {
      orderedThreshold = lowBayerRank.add(0.5).div(4).sub(0.5);
    } else {
      const highX = screenPixel.x.mul(0.5).floor().mod(2);
      const highY = screenPixel.y.mul(0.5).floor().mod(2);
      const highBayerRank = highX.mul(2).add(highY.mul(3))
        .sub(highX.mul(highY).mul(4));
      orderedThreshold = lowBayerRank.mul(4).add(highBayerRank)
        .add(0.5).div(16).sub(0.5);
    }

    const displayLuminance = finalLinear.dot(vec3(0.2126, 0.7152, 0.0722));
    const displayStrongest = finalLinear.r.max(finalLinear.g).max(finalLinear.b);
    // No threshold, noise, or glow may turn genuinely empty space into a star.
    const physicalPresence = smoothstep(
      this.phosphorProtection.x,
      this.phosphorProtection.x.add(this.phosphorProtection.y),
      displayStrongest,
    ).mul(smoothstep(0.003, 0.04, centerStrongest));
    const actualEmitterProtection = emitterWeight.max(stellarEmitter)
      .max(protectedAccent.mul(0.45));
    const protectedSurface = float(1)
      .sub(actualEmitterProtection.mul(this.phosphorProtection.z)).max(0);
    const treatmentWeight = this.phosphorGrading.x
      .mul(this.phosphorProtection.w).mul(physicalPresence).mul(protectedSurface)
      // Ordered palette steps belong on broad gradients, not on the newly
      // resolved coverage of fine hull seams, silhouettes, and thin rings.
      .mul(coverageProtection);

    // Quantize one scalar, never separate RGB channels: faceted teal oceans,
    // indigo land, ivory hull panels, and genuine stellar spectra retain hue.
    const paletteLevels = this.phosphorGrading.y.max(2);
    const quantizedLuminance = displayLuminance.mul(paletteLevels)
      .add(orderedThreshold.mul(this.phosphorGrading.z)).add(0.5)
      .floor().div(paletteLevels).max(0);
    const quantizedColor = finalLinear.mul(
      quantizedLuminance.div(displayLuminance.max(0.0001)),
    );
    let phosphorLinear = mix(finalLinear, quantizedColor, treatmentWeight);

    // Stable two-pixel rows and a subtle three-pixel luminance aperture avoid
    // temporal grain, RGB fringing, full-screen blur, and crawling dark noise.
    const scanlinePitch = this.phosphorTexture.w.max(1);
    const scanlinePhase = screenPixel.y.mod(scanlinePitch)
      .div(scanlinePitch.sub(1).max(1));
    phosphorLinear = phosphorLinear.mul(float(1).sub(
      scanlinePhase.mul(this.phosphorGrading.w).mul(treatmentWeight),
    ));

    const phosphorPitch = this.phosphorTexture.y.max(1);
    const aperturePhase = screenPixel.x.mod(phosphorPitch)
      .div(phosphorPitch.sub(1).max(1));
    const apertureContrast = aperturePhase.sub(0.5).abs().mul(2);
    phosphorLinear = phosphorLinear.mul(float(1).sub(
      apertureContrast.mul(this.phosphorTexture.x).mul(treatmentWeight).mul(0.22),
    ));

    // Reuse the already-fetched horizontal neighbors; the same-channel scalar
    // limits phosphor streaking to genuine compact engines, rings, and suns.
    const horizontalLuminance = left.add(right).mul(0.5)
      .dot(vec3(0.2126, 0.7152, 0.0722)).max(0);
    const centerLuminance = center.dot(vec3(0.2126, 0.7152, 0.0722)).max(0.035);
    const horizontalEnergy = horizontalLuminance.div(centerLuminance).min(1);
    const horizontalBleed = horizontalEnergy.mul(emitterWeight)
      .mul(physicalPresence).mul(this.phosphorProtection.w)
      .mul(this.phosphorGrading.x).mul(this.phosphorTexture.z).mul(coverageProtection);
    phosphorLinear = phosphorLinear.mul(float(1).add(horizontalBleed));

    this.pipeline = new RenderPipeline(renderer as unknown as WebGPURenderer);
    this.pipeline.outputColorTransform = false;
    this.pipeline.outputNode = renderOutput(
      vec4(phosphorLinear, 1),
      THREE.NoToneMapping,
      renderer.outputColorSpace ?? THREE.SRGBColorSpace,
    );
    this.pipeline.needsUpdate = true;
  }

  /** Current frozen presentation profile; authoritative simulation is untouched. */
  get phosphorSettings(): Readonly<NeonPhosphorSettings> {
    return this.currentPhosphorSettings;
  }

  /** Change only existing GPU uniform values, never the node graph or passes. */
  setPhosphorMode(mode: NeonPhosphorMode): Readonly<NeonPhosphorSettings> {
    const settings = resolveNeonPhosphorSettings(mode, this.settings.quality);
    if (settings === this.currentPhosphorSettings) return settings;

    this.currentPhosphorSettings = settings;
    this.phosphorGrading.value.set(
      settings.intensity,
      settings.paletteLevels,
      settings.ditherStrength,
      settings.scanlineStrength,
    );
    this.phosphorTexture.value.set(
      settings.phosphorStrength,
      settings.phosphorPitchPixels,
      settings.horizontalBleedStrength,
      settings.scanlinePitchPixels,
    );
    this.phosphorProtection.value.set(
      settings.blackFloor,
      settings.blackFeather,
      settings.highlightProtection,
      settings.enabled ? 1 : 0,
    );
    this.presentationControls.value.set(settings.sharpenScale, settings.contrastScale);
    return settings;
  }

  /**
   * Update genuine stellar optics and eye adaptation on the real local clock.
   * Existing callers may continue using render() without a celestial frame.
   */
  setCelestialFrame(
    frame: CelestialLightFrame,
    localRealDeltaSeconds: number,
    projectedSources: readonly ProjectedCelestialSource[] = [],
  ): void {
    const exposure = this.exposureController.update(
      frame,
      localRealDeltaSeconds,
      projectedSources,
    );
    this.renderer.toneMappingExposure = exposure;
    this.exposure.value = exposure;

    const boundedProjectedSources = projectedSources.slice(0, 3);
    if (this.settings.quality === 'fallback') {
      boundedProjectedSources.sort((left, right) => {
        const leftSource = frame.sources.find(
          (source) => source.active && source.id === left.id,
        );
        const rightSource = frame.sources.find(
          (source) => source.active && source.id === right.id,
        );
        const leftEnergy = left.visible && leftSource
          ? leftSource.receivedIrradianceSolar * leftSource.visibility
          : 0;
        const rightEnergy = right.visible && rightSource
          ? rightSource.receivedIrradianceSolar * rightSource.visibility
          : 0;
        return rightEnergy - leftEnergy;
      });
    }

    let index = 0;
    for (const projected of boundedProjectedSources) {
      const source = frame.sources.find((entry) => entry.active && entry.id === projected.id);
      if (!source) continue;
      const optical = this.celestialOptics[index]!;
      optical.position.value.set(
        THREE.MathUtils.clamp(projected.u, 0, 1),
        THREE.MathUtils.clamp(projected.v, 0, 1),
      );
      optical.color.value.setRGB(
        Math.max(0, source.spectralColor.r * source.atmosphericTransmittance.r),
        Math.max(0, source.spectralColor.g * source.atmosphericTransmittance.g),
        Math.max(0, source.spectralColor.b * source.atmosphericTransmittance.b),
      );
      optical.state.value.set(
        THREE.MathUtils.clamp(projected.angularRadius, 0.00035, 0.05),
        projected.visible ? THREE.MathUtils.clamp(source.visibility, 0, 1) : 0,
        THREE.MathUtils.clamp(
          Math.sqrt(Math.max(0, source.receivedIrradianceSolar)) * 0.75 + 0.42,
          0,
          1.65,
        ),
        THREE.MathUtils.clamp(frame.atmosphereDensity, 0, 1),
      );
      index += 1;
    }

    for (; index < this.celestialOptics.length; index += 1) {
      this.celestialOptics[index]!.state.value.set(0.001, 0, 0, 0);
    }
  }

  render(
    world: THREE.Scene,
    camera: THREE.Camera,
    renderForeground: () => void,
    background?: THREE.Scene,
  ): void {
    if (this.disposed) return;
    this.syncDrawingBuffer();
    this.exposure.value = this.renderer.toneMappingExposure ?? 1;

    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoReset = this.renderer.info.autoReset;
    const previousAutoClear = this.renderer.autoClear;
    this.renderer.info.reset();
    this.renderer.info.autoReset = false;

    try {
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(this.target);
      if (background) {
        // Unreachable-looking sky overdraw is a queue-order problem, not a
        // reason to draw the exterior ship on top of terrain. Catalog stars
        // and anchored gas render first; every physical world object then
        // shares one real depth buffer. Only the cockpit may clear it again.
        this.renderer.render(background, camera);
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
      }
      this.renderer.render(world, camera);
      // The optional camera-local cockpit remains in the same linear HDR target.
      renderForeground();
      this.renderer.setRenderTarget(null);
      this.renderer.autoClear = true;
      this.pipeline.render();
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.autoClear = previousAutoClear;
      this.renderer.info.autoReset = previousAutoReset;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.smaaNode?.dispose();
    if (this.smaaInputNode) {
      this.smaaInputNode.renderTarget?.dispose();
      // r185 RTTNode inherits Node.dispose(), which only dispatches an event;
      // it does not release its own fullscreen material. This is our one RTT.
      const input = this.smaaInputNode as unknown as { _quadMesh: { material: THREE.Material } };
      input._quadMesh.material.dispose();
      this.smaaInputNode.dispose();
    }
    this.bloomNode?.dispose();
    this.pipeline.dispose();
    this.target.dispose();
  }

  private syncDrawingBuffer(): void {
    this.renderer.getDrawingBufferSize(this.drawingBuffer);
    const width = Math.max(1, Math.round(this.drawingBuffer.x));
    const height = Math.max(1, Math.round(this.drawingBuffer.y));
    if (this.target.width === width && this.target.height === height) return;
    this.target.setSize(width, height);
    this.smaaInputNode?.setSize(width, height);
    this.smaaNode?.setSize(width, height);
    this.texelSize.value.set(1 / width, 1 / height);
  }
}
