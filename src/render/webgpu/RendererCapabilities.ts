export type RendererBackend = 'webgpu' | 'webgl2';

/** Narrow public shape shared by Three r185's initialized backend classes. */
export interface InitializedRendererBackend {
  readonly isWebGPUBackend?: boolean;
  readonly isWebGLBackend?: boolean;
  readonly device?: {
    readonly limits?: {
      readonly maxTextureDimension2D?: number;
    };
  } | null;
  readonly gl?: {
    readonly MAX_TEXTURE_SIZE: number;
    getParameter(parameter: number): unknown;
  } | null;
  getContext?(): unknown;
}

/** Backend flags become authoritative only after WebGPURenderer.init(). */
export function detectRendererBackend(backend: InitializedRendererBackend): RendererBackend {
  const webgpu = backend.isWebGPUBackend === true;
  const webgl = backend.isWebGLBackend === true;

  if (webgpu === webgl) {
    throw new Error('The initialized Three renderer has no unique supported graphics backend.');
  }

  return webgpu ? 'webgpu' : 'webgl2';
}

/** Read the actual device/context limit without inventing cross-API values. */
export function maximumBackendTextureSize(backend: InitializedRendererBackend): number {
  if (detectRendererBackend(backend) === 'webgpu') {
    const maximum = backend.device?.limits?.maxTextureDimension2D;
    if (typeof maximum === 'number' && Number.isFinite(maximum) && maximum > 0) {
      return maximum;
    }

    throw new Error('The initialized WebGPU device did not expose its texture limit.');
  }

  const context = backend.gl ?? backend.getContext?.();
  if (typeof context === 'object' && context !== null) {
    const graphics = context as {
      MAX_TEXTURE_SIZE?: unknown;
      getParameter?: (parameter: number) => unknown;
    };
    if (typeof graphics.MAX_TEXTURE_SIZE === 'number' && typeof graphics.getParameter === 'function') {
      const maximum = graphics.getParameter(graphics.MAX_TEXTURE_SIZE);
      if (typeof maximum === 'number' && Number.isFinite(maximum) && maximum > 0) {
        return maximum;
      }
    }
  }

  throw new Error('The initialized WebGL2 context did not expose its texture limit.');
}
