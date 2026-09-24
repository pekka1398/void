import type { RendererBackend } from './webgpu/RendererCapabilities';

/** Player preference; this never pretends that the selected backend changed. */
export type GraphicsQuality = 'high' | 'low';
export type RenderQualityTier = 'high' | 'fallback';

export const DEFAULT_GRAPHICS_QUALITY: GraphicsQuality = 'high';
export const GRAPHICS_QUALITY_STORAGE_KEY = 'void-explorer:display:graphics-quality:v1';
export const GRAPHICS_QUALITY_QUERY_KEY = 'quality';

export const GRAPHICS_RESOLUTION_CAPS = Object.freeze({
  high: Object.freeze({ width: 1920, height: 1200 }),
  low: Object.freeze({ width: 960, height: 600 }),
});

function validGraphicsQuality(value: unknown): GraphicsQuality | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'high' || normalized === 'low' ? normalized : undefined;
}

export function normalizeGraphicsQuality(value: unknown): GraphicsQuality {
  return validGraphicsQuality(value) ?? DEFAULT_GRAPHICS_QUALITY;
}

/** Explicit diagnostic/shareable URL choice, then saved choice, then High. */
export function resolveGraphicsQualityPreference(search: string, saved: unknown): GraphicsQuality {
  return validGraphicsQuality(new URLSearchParams(search).get(GRAPHICS_QUALITY_QUERY_KEY)) ??
    validGraphicsQuality(saved) ?? DEFAULT_GRAPHICS_QUALITY;
}

/** Keep explicit URL overrides truthful, including when storage is blocked. */
export function graphicsQualityReloadUrl(
  href: string,
  quality: GraphicsQuality,
  preferenceStored: boolean,
): string {
  const url = new URL(href);
  if (!preferenceStored || url.searchParams.has(GRAPHICS_QUALITY_QUERY_KEY)) {
    url.searchParams.set(GRAPHICS_QUALITY_QUERY_KEY, quality);
  }
  return url.href;
}

/** WebGL retains the proven compatibility budgets; Low also works on WebGPU. */
export function resolveRenderQualityTier(
  requested: GraphicsQuality,
  backend: RendererBackend,
): RenderQualityTier {
  return requested === 'high' && backend === 'webgpu' ? 'high' : 'fallback';
}

export function resolutionCapForTier(tier: RenderQualityTier): Readonly<{ width: number; height: number }> {
  return GRAPHICS_RESOLUTION_CAPS[tier === 'high' ? 'high' : 'low'];
}

/** Bound real GPU pixels without supersampling beyond the physical display. */
export function renderPixelRatio(
  width: number,
  height: number,
  devicePixelRatio: number,
  tier: RenderQualityTier,
): number {
  const viewportWidth = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
  const viewportHeight = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const physicalRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const cap = resolutionCapForTier(tier);
  return Math.min(physicalRatio, cap.width / viewportWidth, cap.height / viewportHeight);
}
