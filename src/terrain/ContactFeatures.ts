import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from '../core/Vec3';
import {
  hashCoordinates,
  hashUnit,
  samplePlanetField,
  type PlanetField,
  type Rgb,
} from '../fields';
import type { ContactFlowDescriptor, ContactGeometryOptions, ContactSolidDescriptor } from './ContactGeometry';
import { buildSurfaceFlowRegion } from './SurfaceFlowField';
import { surfaceFlowContains as contactFlowContains } from './SurfaceFlowGeometry';
import { createSurfaceTerrainPalette, sampleSurfaceTerrainColor } from './SurfaceTerrainPresentation';

export { contactFlowContains };

interface SurfaceCell {
  id: string;
  seed: number;
  direction: Vec3;
}

const clamp = (value: number, minimum = 0, maximum = 1): number => Math.max(minimum, Math.min(maximum, value));

/**
 * A body-fixed Cartesian lattice is deliberately independent of the current
 * camera, cube face, contact lease, and floating origin. Negative cells keep
 * the same floor/hash rule as positive cells.
 */
function surfaceCells(
  field: PlanetField,
  centerDirection: Readonly<Vec3>,
  extentMeters: number,
  cellMeters: number,
  salt: number,
): SurfaceCell[] {
  const center = scaleVec3(centerDirection, field.radius);
  const extent = extentMeters + cellMeters;
  const minimum = {
    x: Math.floor((center.x - extent) / cellMeters),
    y: Math.floor((center.y - extent) / cellMeters),
    z: Math.floor((center.z - extent) / cellMeters),
  };
  const maximum = {
    x: Math.floor((center.x + extent) / cellMeters),
    y: Math.floor((center.y + extent) / cellMeters),
    z: Math.floor((center.z + extent) / cellMeters),
  };
  const cells: SurfaceCell[] = [];
  for (let x = minimum.x; x <= maximum.x; x += 1) {
    for (let y = minimum.y; y <= maximum.y; y += 1) {
      for (let z = minimum.z; z <= maximum.z; z += 1) {
        const seed = hashCoordinates(x, y, z, field.seed ^ salt);
        const point = {
          x: (x + 0.3 + hashUnit(seed ^ 0x2854_a37b) * 0.4) * cellMeters,
          y: (y + 0.3 + hashUnit(seed ^ 0x6d2f_5149) * 0.4) * cellMeters,
          z: (z + 0.3 + hashUnit(seed ^ 0xa281_037d) * 0.4) * cellMeters,
        };
        const radius = lengthVec3(point);
        // Exactly one fixed thin spherical shell; never a camera-local scatter.
        if (radius <= 0 || Math.abs(radius - field.radius) > cellMeters * 0.52) continue;
        const direction = scaleVec3(point, 1 / radius);
        if (lengthVec3(subVec3(scaleVec3(direction, field.radius), center)) > extentMeters + cellMeters * 0.55) continue;
        cells.push({ id: `${x},${y},${z}`, seed, direction });
      }
    }
  }
  return cells;
}

function tangentBasis(direction: Readonly<Vec3>): { east: Vec3; north: Vec3 } {
  const reference = Math.abs(direction.y) > 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const east = normalizeVec3(crossVec3(reference, direction));
  return { east, north: normalizeVec3(crossVec3(east, direction)) };
}

function flowNearRegion(
  field: PlanetField,
  flow: ContactFlowDescriptor,
  centerDirection: Readonly<Vec3>,
  radiusMeters: number,
): boolean {
  const distance = lengthVec3(subVec3(flow.centerDirection, centerDirection)) * field.radius;
  return distance <= radiusMeters * Math.SQRT2 + flow.halfLengthMeters + flow.halfWidthMeters;
}

function buildSolids(
  field: PlanetField,
  centerDirection: Readonly<Vec3>,
  radiusMeters: number,
  flows: readonly ContactFlowDescriptor[],
  maximum: number,
): ContactSolidDescriptor[] {
  if (maximum <= 0) return [];
  const solids: ContactSolidDescriptor[] = [];
  const palette = createSurfaceTerrainPalette(field);
  const accent = palette.accent;
  const frozen = field.archetype === 'frozen' || field.archetype === 'ice-moon';
  const cells = surfaceCells(field, centerDirection, radiusMeters * Math.SQRT2 + 9, 28, 0x324a_7b19);
  for (const cell of cells) {
    const chance = hashUnit(cell.seed ^ 0x081f_c43b);
    if (chance > (frozen ? 0.28 : 0.2)) continue;
    const sample = samplePlanetField(field, cell.direction);
    if (sample.ocean || sample.biome === 'lava') continue;
    if ((field.archetype === 'ocean' || field.archetype === 'temperate') && sample.heightMeters < 2) continue;
    if (flows.some((flow) => contactFlowContains(field.radius, flow, cell.direction, 7))) continue;
    const variation = hashUnit(cell.seed ^ 0x6ba7_9183);
    const kind: ContactSolidDescriptor['kind'] = sample.ridgeStrength > 0.32 && variation > 0.79
      ? 'ridge'
      : frozen || (sample.mineralRichness ?? 0) > 0.58 && variation > 0.48 ? 'crystal' : 'rock';
    const height = kind === 'crystal' ? 0.85 + variation * 3.0
      : kind === 'ridge' ? 1.5 + variation * 3.4 : 0.55 + variation * 2.1;
    const width = kind === 'crystal' ? height * (0.24 + variation * 0.13)
      : kind === 'ridge' ? height * (1.15 + variation * 0.8) : height * (0.66 + variation * 0.6);
    const depth = kind === 'ridge' ? height * 0.57 : width * (0.76 + variation * 0.4);
    const basis = tangentBasis(cell.direction);
    const angle = hashUnit(cell.seed ^ 0x731b_542d) * Math.PI * 2;
    const right = normalizeVec3(addVec3(scaleVec3(basis.east, Math.cos(angle)), scaleVec3(basis.north, Math.sin(angle))));
    const forward = normalizeVec3(crossVec3(right, cell.direction));
    const base = scaleVec3(cell.direction, field.radius + sample.heightMeters);
    const colorMix = kind === 'crystal' ? 0.35 : 0.07;
    const groundColor = sampleSurfaceTerrainColor(palette, field, sample, cell.direction);
    const color = groundColor.map((channel, index) => clamp(channel * (1 - colorMix) + accent[index]! * colorMix)) as unknown as Rgb;
    solids.push(Object.freeze({
      id: `${field.seed}:${kind}:${cell.id}`,
      kind,
      centerBodyFixedMeters: Object.freeze(addVec3(base, scaleVec3(cell.direction, height * 0.5))),
      halfExtentsMeters: Object.freeze({ x: width * 0.5, y: height * 0.5, z: depth * 0.5 }),
      rightBodyFixed: Object.freeze(right),
      upBodyFixed: Object.freeze({ ...cell.direction }),
      forwardBodyFixed: Object.freeze(forward),
      color: Object.freeze(color),
      variation,
    }));
  }
  const center = scaleVec3(centerDirection, field.radius);
  solids.sort((a, b) => lengthVec3(subVec3(a.centerBodyFixedMeters, center))
    - lengthVec3(subVec3(b.centerBodyFixedMeters, center)) || a.id.localeCompare(b.id));
  return solids.slice(0, maximum);
}

export function buildContactFeatures(
  field: PlanetField,
  centerDirection: Readonly<Vec3>,
  radiusMeters: number,
  options: ContactGeometryOptions = {},
): { solids: readonly ContactSolidDescriptor[]; flows: readonly ContactFlowDescriptor[] } {
  const sourceFlows = options.sourceFlows ?? buildSurfaceFlowRegion(field, {
    centerDirection, patchSizeMeters: Math.max(32_000, radiusMeters * 2), maxInstances: 160,
  }).flows;
  // A real region contains at most 34 channels and five cascades. Preserve all
  // intersecting footprints instead of silently dropping a rendered hazard.
  const flows = sourceFlows.filter((flow) => flowNearRegion(field, flow, centerDirection, radiusMeters + 12));
  if (flows.length > Math.max(0, Math.min(64, options.maxFlows ?? 64))) {
    throw new RangeError('Contact liquid coverage exceeds its immutable region budget.');
  }
  const solids = buildSolids(field, centerDirection, radiusMeters, flows,
    Math.max(0, Math.min(48, Math.floor(options.maxSolids ?? 40))));
  return { solids: Object.freeze(solids), flows: Object.freeze(flows) };
}

/** Conservative, explicitly authored oriented-box collision proxy. */
export function contactSolidContains(
  solid: ContactSolidDescriptor,
  bodyFixedMeters: Readonly<Vec3>,
  radiusMeters = 0,
  verticalRadiusMeters = radiusMeters,
): boolean {
  const relative = subVec3(bodyFixedMeters, solid.centerBodyFixedMeters);
  return Math.abs(dotVec3(relative, solid.rightBodyFixed)) <= solid.halfExtentsMeters.x + radiusMeters
    && Math.abs(dotVec3(relative, solid.upBodyFixed)) <= solid.halfExtentsMeters.y + verticalRadiusMeters
    && Math.abs(dotVec3(relative, solid.forwardBodyFixed)) <= solid.halfExtentsMeters.z + radiusMeters;
}
