import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';

import {
  DEFAULT_GRAPHICS_QUALITY,
  normalizeGraphicsQuality,
  renderPixelRatio,
  resolutionCapForTier,
  resolveRenderQualityTier,
  type GraphicsQuality,
  type RenderQualityTier,
} from './GraphicsQuality';

import {
  detectRendererBackend,
  maximumBackendTextureSize,
  type InitializedRendererBackend,
  type RendererBackend,
} from './webgpu/RendererCapabilities';
import { PALETTE } from './style/Palette';

/** VoidExplorer always owns a browser canvas, never an OffscreenCanvas. */
export type BrowserWebGPURenderer = WebGPURenderer & {
  readonly domElement: HTMLCanvasElement;
};

export type RendererDeviceStatus = 'initializing' | 'ready' | 'lost' | 'error' | 'disposed';

export interface SceneTargetAntialiasing {
  readonly requestedSamples: 4;
  /** Zero means that no native offscreen multisample target was selected. */
  readonly samples: 0 | 2 | 4;
  readonly mode: 'msaa' | 'none';
  readonly precision: 'rgba16f' | 'rgba8';
  readonly supportedSamples: readonly number[];
  readonly reason?: string;
}

export interface RendererCapabilities {
  backend: RendererBackend;
  /** True only after an actual WebGPU device has successfully initialized. */
  webgpuAvailable: boolean;
  logarithmicDepth: boolean;
  reversedDepth: boolean;
  maxTextureSize: number;
  /** Player preference and actual compatible tier are deliberately separate. */
  readonly requestedQuality: GraphicsQuality;
  quality: RenderQualityTier;
  /** Reports the real selected device lifecycle, never navigator.gpu presence. */
  deviceStatus: RendererDeviceStatus;
  deviceLost: boolean;
  deviceLossReason?: string;
  /** Actual offscreen color/depth format support, populated after device init. */
  sceneAntialiasing?: Readonly<SceneTargetAntialiasing>;
  /** The final full-screen presentation quad does not need another MSAA buffer. */
  canvasSamples?: number;
}

export interface RendererMetrics {
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  pixelRatio: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
}

export interface RendererHostOptions {
  readonly graphicsQuality?: GraphicsQuality;
}

interface SceneTargetBackend {
  readonly isWebGPUBackend?: boolean;
  readonly isWebGLBackend?: boolean;
  readonly device?: object | null;
  readonly gl?: unknown;
  getContext?(): unknown;
}

interface SceneTargetWebGLContext {
  readonly MAX_SAMPLES: number;
  readonly RENDERBUFFER: number;
  readonly RGBA16F: number;
  readonly RGBA8: number;
  readonly DEPTH_COMPONENT24: number;
  readonly SAMPLES: number;
  getParameter(parameter: number): unknown;
  getInternalformatParameter(target: number, format: number, parameter: number): unknown;
  getExtension?(name: string): unknown;
}

/** The actual initialized WebGL color-buffer extensions determine HDR storage. */
export function supportsSceneHalfFloat(backendInput: object | undefined): boolean {
  const backend = backendInput as SceneTargetBackend | undefined;
  if (!backend?.isWebGLBackend) return true;
  const context = (backend.gl ?? backend.getContext?.()) as Partial<SceneTargetWebGLContext> | undefined;
  if (!context?.getExtension) return false;
  return Boolean(context.getExtension('EXT_color_buffer_float') ||
    context.getExtension('EXT_color_buffer_half_float'));
}

/**
 * Select an actual common color/depth MSAA count for the offscreen world.
 * Three r185's WebGPUUtils supports exactly one or four samples. WebGL2
 * renderbuffer support is format-specific, so MAX_SAMPLES alone is not enough
 * to promise that an RGBA16F target with a depth24 attachment is complete.
 */
export function resolveSceneTargetAntialiasing(
  backendInput: object | undefined,
  precision: 'rgba16f' | 'rgba8',
): Readonly<SceneTargetAntialiasing> {
  const backend = backendInput as SceneTargetBackend | undefined;
  const result = (samples: 0 | 2 | 4, supportedSamples: readonly number[], reason?: string) => Object.freeze({
    requestedSamples: 4 as const,
    samples,
    mode: samples > 0 ? 'msaa' as const : 'none' as const,
    precision,
    supportedSamples: Object.freeze([...supportedSamples]),
    ...(reason ? { reason } : {}),
  });

  if (backend?.isWebGPUBackend === true && backend.isWebGLBackend !== true) {
    return backend.device
      ? result(4, [4])
      : result(0, [], 'WebGPU device has not initialized');
  }
  if (backend?.isWebGLBackend !== true || backend.isWebGPUBackend === true) {
    return result(0, [], 'No initialized graphics backend');
  }

  const context = (backend.gl ?? backend.getContext?.()) as Partial<SceneTargetWebGLContext> | undefined;
  const colorFormat = precision === 'rgba16f' ? context?.RGBA16F : context?.RGBA8;
  if (!context || typeof context.getParameter !== 'function' ||
    typeof context.getInternalformatParameter !== 'function' ||
    typeof context.MAX_SAMPLES !== 'number' || typeof context.RENDERBUFFER !== 'number' ||
    typeof context.DEPTH_COMPONENT24 !== 'number' || typeof context.SAMPLES !== 'number' ||
    typeof colorFormat !== 'number') {
    return result(0, [], 'WebGL2 format sample counts are unavailable');
  }

  try {
    const maximum = Number(context.getParameter(context.MAX_SAMPLES));
    const counts = (format: number): number[] => {
      const value = context.getInternalformatParameter!(context.RENDERBUFFER!, format, context.SAMPLES!);
      if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return [];
      return Array.from(value as ArrayLike<number>).filter((sample) =>
        Number.isInteger(sample) && sample > 1 && sample <= maximum);
    };
    const depthCounts = new Set(counts(context.DEPTH_COMPONENT24));
    const common = [...new Set(counts(colorFormat))]
      .filter((sample) => depthCounts.has(sample)).sort((left, right) => right - left);
    if (common.includes(4)) return result(4, common);
    if (common.includes(2)) return result(2, common, `${precision} and depth24 support 2x MSAA`);
    return result(0, common, `${precision} and depth24 have no common 2x or 4x MSAA count`);
  } catch {
    return result(0, [], 'WebGL2 format sample query failed');
  }
}

type ObservableGraphicsDevice = {
  lost?: PromiseLike<{ reason?: string; message?: string }>;
};

/** Observe only an actual selected GPUDevice; WebGL never claims a GPU loss. */
export function observeRendererDeviceLoss(
  capabilities: RendererCapabilities,
  backend: InitializedRendererBackend,
  disposed: () => boolean,
): void {
  if (!backend.isWebGPUBackend) return;
  const device = backend.device as ObservableGraphicsDevice | null | undefined;
  if (!device?.lost) return;

  void Promise.resolve(device.lost).then(
    (loss) => {
      if (disposed()) return;
      capabilities.deviceStatus = 'lost';
      capabilities.deviceLost = true;
      capabilities.webgpuAvailable = false;
      capabilities.deviceLossReason = loss.message || loss.reason || 'WebGPU device was lost';
    },
    (error: unknown) => {
      if (disposed()) return;
      capabilities.deviceStatus = 'error';
      capabilities.deviceLost = true;
      capabilities.webgpuAvailable = false;
      capabilities.deviceLossReason = error instanceof Error
        ? error.message
        : 'WebGPU device loss could not be observed';
    },
  );
}

/** One initialized Three node renderer owns both real WebGPU and WebGL2. */
export class RendererHost {
  readonly renderer: BrowserWebGPURenderer;
  readonly capabilities: RendererCapabilities;
  private readonly drawingBufferSize = new THREE.Vector2();
  private pixelRatio = 1;
  private initialized = false;
  private disposed = false;

  private constructor(parent: HTMLElement, options: RendererHostOptions) {
    const forceFallback = new URLSearchParams(window.location.search).has('forceWebGL');
    const requestedQuality = normalizeGraphicsQuality(options.graphicsQuality ?? DEFAULT_GRAPHICS_QUALITY);

    const renderer = new WebGPURenderer({
      // The scene's own HDR target performs real MSAA. Multisampling this
      // final full-screen presentation quad again adds cost, not coverage.
      antialias: false,
      samples: 0,
      alpha: false,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
      // Three r185 has an unresolved reversed-depth ordering problem.
      reversedDepthBuffer: false,
      stencil: false,
      forceWebGL: forceFallback,
    });
    const canvas = renderer.domElement;
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('VoidExplorer requires an interactive HTML canvas.');
    }
    this.renderer = renderer as BrowserWebGPURenderer;
    this.capabilities = {
      backend: 'webgl2',
      webgpuAvailable: false,
      logarithmicDepth: renderer.logarithmicDepthBuffer,
      reversedDepth: renderer.reversedDepthBuffer,
      maxTextureSize: 0,
      requestedQuality,
      quality: resolveRenderQualityTier(requestedQuality, forceFallback ? 'webgl2' : 'webgpu'),
      deviceStatus: 'initializing',
      deviceLost: false,
    };

    renderer.setClearColor(PALETTE.void, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.34;
    this.applyViewportSize(window.innerWidth, window.innerHeight);
    canvas.id = 'void-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Void Explorer game view');
    parent.append(canvas);
  }

  /** Await adapter selection before constructing materials or rendering. */
  static async create(parent: HTMLElement, options: RendererHostOptions = {}): Promise<RendererHost> {
    const host = new RendererHost(parent, options);

    try {
      await host.initialize();
      return host;
    } catch (error) {
      // Calling Renderer.dispose() after failed init retries its rejected
      // initialization through setAnimationLoop(); remove the canvas only.
      host.renderer.domElement.remove();
      throw error;
    }
  }

  async initialize(): Promise<this> {
    if (this.disposed) throw new Error('Cannot initialize a disposed renderer.');
    if (this.initialized) return this;

    try {
      await this.renderer.init();

      // init() may replace a failed WebGPU backend with WebGLBackend. Inspect
      // its final implementation, not navigator.gpu or the requested option.
      const backend = this.renderer.backend as unknown as InitializedRendererBackend;
      const actualBackend = detectRendererBackend(backend);
      this.capabilities.backend = actualBackend;
      this.capabilities.webgpuAvailable = actualBackend === 'webgpu';
      this.capabilities.quality = resolveRenderQualityTier(this.capabilities.requestedQuality, actualBackend);
      this.capabilities.logarithmicDepth = this.renderer.logarithmicDepthBuffer;
      this.capabilities.reversedDepth = this.renderer.reversedDepthBuffer;
      this.capabilities.maxTextureSize = maximumBackendTextureSize(backend);
      this.capabilities.sceneAntialiasing = resolveSceneTargetAntialiasing(
        backend,
        supportsSceneHalfFloat(backend) ? 'rgba16f' : 'rgba8',
      );
      this.capabilities.canvasSamples = this.renderer.samples;
      this.capabilities.deviceStatus = 'ready';
      this.capabilities.deviceLost = false;
      this.initialized = true;
      // A failed WebGPU adapter can select WebGL during init. Apply its real
      // compatibility tier before any world targets or materials are built.
      this.applyViewportSize(window.innerWidth, window.innerHeight);
      observeRendererDeviceLoss(this.capabilities, backend, () => this.disposed);
    } catch (error) {
      this.capabilities.deviceStatus = 'error';
      this.capabilities.deviceLossReason = error instanceof Error
        ? error.message
        : 'Graphics backend initialization failed';
      throw error;
    }

    return this;
  }

  resize(width: number, height: number): void {
    this.applyViewportSize(width, height);
  }

  get resolutionCap(): Readonly<{ width: number; height: number }> {
    return resolutionCapForTier(this.capabilities.quality);
  }

  getMetrics(): RendererMetrics {
    const buffer = this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const render = this.renderer.info.render;
    const memory = this.renderer.info.memory;
    return {
      drawingBufferWidth: buffer.x,
      drawingBufferHeight: buffer.y,
      pixelRatio: this.pixelRatio,
      // The common renderer counts render submissions in `calls`; its real
      // current-frame primitive submissions live in the separate drawCalls.
      drawCalls: render.drawCalls,
      triangles: render.triangles,
      points: render.points,
      lines: render.lines,
      geometries: memory.geometries,
      textures: memory.textures,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.capabilities.deviceStatus = 'disposed';
    if (this.initialized) this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private applyViewportSize(width: number, height: number): void {
    const viewportWidth = Math.max(1, Math.round(width));
    const viewportHeight = Math.max(1, Math.round(height));
    this.pixelRatio = renderPixelRatio(
      viewportWidth,
      viewportHeight,
      window.devicePixelRatio || 1,
      this.capabilities.quality,
    );
    this.renderer.setPixelRatio(this.pixelRatio);
    // Keep DOM interaction at full viewport size while bounding GPU pixels.
    this.renderer.setSize(viewportWidth, viewportHeight, true);
  }
}
