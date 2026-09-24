import { Color } from 'three';

import { hashUnit, type PlanetField, type Rgb } from '../fields';
import type { Vec3 } from '../core/Vec3';
import type { ContactFlowDescriptor } from './ContactGeometry';
import { createSurfaceTerrainPalette } from './SurfaceTerrainPresentation';

/** Shared by distant scenery and the exact on-foot liquid geometry. */
export const SURFACE_FLOW_TRIANGLE_CORNERS = [0, 2, 1, 1, 2, 3] as const;
export const SURFACE_FLOW_APPEARANCE_POLICY = 'joined-banks-linear-v2' as const;

export interface SurfaceFlowPalette {
  readonly river: Rgb;
  readonly foam: Rgb;
  readonly phase: number;
}

const linear = (hex: string): Rgb => {
  const value = new Color(hex);
  return [value.r, value.g, value.b];
};
const lerp = (a: Rgb, b: Rgb, amount: number): Rgb => [
  a[0] + (b[0] - a[0]) * amount,
  a[1] + (b[1] - a[1]) * amount,
  a[2] + (b[2] - a[2]) * amount,
];
const LAVA_HOT = linear('#FF7D18');
const LAVA_LIGHT = linear('#FFF2A1');
const LAVA_COOL = linear('#D93418');
const LAVA_EDGE = linear('#FFC156');
const RIVER_FOAM = linear('#83D8CE');

/** No field samples or per-section random tint are needed on publication. */
export function createSurfaceFlowPalette(field: PlanetField): SurfaceFlowPalette {
  const water = createSurfaceTerrainPalette(field);
  const base = lerp(water.oceanIndigo, water.nearshoreTeal, 0.42);
  return { river: [base[0] * 0.82, base[1] * 0.82, base[2] * 0.82],
    foam: RIVER_FOAM, phase: hashUnit(field.seed ^ 0x1a64_b913) * Math.PI * 2 };
}

function riverColor(palette: SurfaceFlowPalette, point: Readonly<Vec3>, cascade: boolean): Rgb {
  // Identical physical bank vertices get identical colors across section,
  // contact-lease, worker, and floating-origin boundaries.
  const shade = 0.96 + Math.sin(point.x / 620 + point.y / 870 - point.z / 730 + palette.phase) * 0.035;
  const base = cascade ? lerp(palette.river, palette.foam, 0.44) : palette.river;
  return [base[0] * shade, base[1] * shade, base[2] * shade];
}

/** Six colors in the exact shared [0,2,1 / 1,2,3] triangle order. */
export function surfaceFlowTriangleColors(
  palette: SurfaceFlowPalette,
  flow: ContactFlowDescriptor,
): readonly Rgb[] {
  if (flow.kind === 'lava') {
    // Geothermal channels keep their established two-facet appearance.
    const first = lerp(LAVA_HOT, LAVA_LIGHT, (flow.strength ?? 0) * 0.74);
    const second = lerp(LAVA_COOL, LAVA_EDGE, (flow.variation ?? 0) * 0.7);
    return [first, first, first, second, second, second];
  }
  const corners = flow.cornersBodyFixedMeters.map((point) =>
    riverColor(palette, point, flow.appearance === 'cascade'));
  return SURFACE_FLOW_TRIANGLE_CORNERS.map((corner) => corners[corner]!);
}

export function surfaceFlowCornerAcross(corner: number): number {
  return corner === 0 || corner === 2 ? -1 : 1;
}
