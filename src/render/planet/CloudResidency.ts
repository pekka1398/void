import type { Vec3Like } from '../../fields/noise';

const TWO_PI = Math.PI * 2;

export type CloudResidencyLayer = 'near' | 'far';

/** CPU descriptors may be prefetched; only these fixed GPU slots are drawn. */
export const CLOUD_RESIDENCY_LIMITS = Object.freeze({
  nearSlots: 49,
  farSlots: 40,
  nearCellMeters: 900,
  farCellMeters: 9_000,
  nearFadeStartCells: 2.1,
  nearFadeEndCells: 3.7,
  farFadeStartCells: 2.35,
  farFadeEndCells: Math.sqrt(13),
  cachedCellsPerLayer: 256,
  candidateCellsPerRegion: 160,
  newCellsPerLayerUpdate: 8,
  regionHysteresisCells: 0.9,
  prefetchRingCells: 1.55,
  retainedPriorityCells: 0.18,
  fadeSeconds: 0.65,
});

export interface CloudCell {
  readonly id: string;
  readonly layer: CloudResidencyLayer;
  readonly row: number;
  readonly column: number;
  readonly columns: number;
  readonly latitudeRadians: number;
  readonly longitudeRadians: number;
  readonly latitudeStepRadians: number;
  readonly longitudeStepRadians: number;
  readonly direction: Vec3Like;
}

export interface CloudCellGrid {
  readonly bodyId: string;
  readonly layer: CloudResidencyLayer;
  readonly radiusMeters: number;
  readonly cellMeters: number;
  readonly rows: number;
  readonly latitudeStepRadians: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));
const wrap = (value: number, period: number): number => ((value % period) + period) % period;

function normalized(raw: Vec3Like): Vec3Like {
  const length = Math.hypot(raw.x, raw.y, raw.z);
  return length > Number.EPSILON && Number.isFinite(length)
    ? { x: raw.x / length, y: raw.y / length, z: raw.z / length }
    : { x: 0, y: 1, z: 0 };
}

export function cloudSurfaceDistanceMeters(a: Vec3Like, b: Vec3Like, radiusMeters: number): number {
  // atan2 is stable for meter-scale separations on an Earth-radius body.
  const cross = Math.hypot(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  return Math.atan2(cross, a.x * b.x + a.y * b.y + a.z * b.z) * radiusMeters;
}

export function createCloudCellGrid(
  bodyId: string,
  radiusMeters: number,
  layer: CloudResidencyLayer,
): CloudCellGrid {
  const cellMeters = layer === 'near'
    ? CLOUD_RESIDENCY_LIMITS.nearCellMeters : CLOUD_RESIDENCY_LIMITS.farCellMeters;
  const radius = Math.max(1, radiusMeters);
  const rows = Math.max(1, Math.round(Math.PI * radius / cellMeters));
  return Object.freeze({ bodyId, layer, radiusMeters: radius, cellMeters,
    rows, latitudeStepRadians: Math.PI / rows });
}

function rowShape(grid: CloudCellGrid, rawRow: number) {
  const row = clamp(Math.trunc(rawRow), 0, grid.rows - 1);
  const latitudeRadians = -Math.PI / 2 + (row + 0.5) * grid.latitudeStepRadians;
  const columns = Math.max(1, Math.round(TWO_PI * grid.radiusMeters * Math.cos(latitudeRadians) / grid.cellMeters));
  return { row, latitudeRadians, columns, longitudeStepRadians: TWO_PI / columns };
}

/** Every latitude band wraps exactly; its columns remain approximately real cellMeters wide. */
export function cloudCellAt(grid: CloudCellGrid, row: number, column: number): CloudCell {
  const shape = rowShape(grid, row);
  const canonicalColumn = wrap(Math.trunc(column), shape.columns);
  const longitudeRadians = -Math.PI + (canonicalColumn + 0.5) * shape.longitudeStepRadians;
  const horizontal = Math.cos(shape.latitudeRadians);
  return {
    ...shape,
    id: `${grid.bodyId}:${grid.layer}:${shape.row}:${canonicalColumn}`,
    layer: grid.layer,
    column: canonicalColumn,
    latitudeStepRadians: grid.latitudeStepRadians,
    longitudeRadians,
    direction: {
      x: horizontal * Math.cos(longitudeRadians),
      y: Math.sin(shape.latitudeRadians),
      z: horizontal * Math.sin(longitudeRadians),
    },
  };
}

export function cloudCellForDirection(grid: CloudCellGrid, rawDirection: Vec3Like): CloudCell {
  const direction = normalized(rawDirection);
  const latitude = Math.asin(clamp(direction.y, -1, 1));
  const row = clamp(Math.floor((latitude + Math.PI / 2) / grid.latitudeStepRadians), 0, grid.rows - 1);
  const shape = rowShape(grid, row);
  const longitude = Math.atan2(direction.z, direction.x);
  return cloudCellAt(grid, row, Math.floor((longitude + Math.PI) / shape.longitudeStepRadians));
}

/** Enumerate a bounded spherical cap, including the opposite longitude at a pole. */
export function cloudCellsAround(
  grid: CloudCellGrid,
  rawDirection: Vec3Like,
  radiusMeters: number,
): CloudCell[] {
  const direction = normalized(rawDirection);
  const latitude = Math.asin(clamp(direction.y, -1, 1));
  const longitude = Math.atan2(direction.z, direction.x);
  // Cell-center margin covers the permanent in-cell jitter, not a moving mesh.
  const angularRadius = Math.min(Math.PI, (Math.max(0, radiusMeters) + grid.cellMeters * 0.36) / grid.radiusMeters);
  const firstRow = clamp(Math.floor((latitude - angularRadius + Math.PI / 2) / grid.latitudeStepRadians), 0, grid.rows - 1);
  const lastRow = clamp(Math.floor((latitude + angularRadius + Math.PI / 2) / grid.latitudeStepRadians), 0, grid.rows - 1);
  const found = new Map<string, CloudCell>();
  for (let row = firstRow; row <= lastRow; row += 1) {
    const shape = rowShape(grid, row);
    const divisor = Math.cos(latitude) * Math.cos(shape.latitudeRadians);
    const threshold = divisor > 1e-12
      ? (Math.cos(angularRadius) - Math.sin(latitude) * Math.sin(shape.latitudeRadians)) / divisor
      : (Math.abs(latitude - shape.latitudeRadians) <= angularRadius ? -1 : 2);
    if (threshold > 1) continue;
    const halfWidth = threshold <= -1 ? Math.PI : Math.acos(clamp(threshold, -1, 1));
    const first = Math.floor((longitude - halfWidth + Math.PI) / shape.longitudeStepRadians);
    const last = Math.floor((longitude + halfWidth + Math.PI) / shape.longitudeStepRadians);
    const count = Math.min(shape.columns, last - first + 1);
    for (let offset = 0; offset < count; offset += 1) {
      const cell = cloudCellAt(grid, row, first + offset);
      if (cloudSurfaceDistanceMeters(direction, cell.direction, grid.radiusMeters) <=
          angularRadius * grid.radiusMeters + 1e-5) found.set(cell.id, cell);
    }
  }
  return [...found.values()].sort((a, b) =>
    cloudSurfaceDistanceMeters(direction, a.direction, grid.radiusMeters) -
      cloudSurfaceDistanceMeters(direction, b.direction, grid.radiusMeters) || a.id.localeCompare(b.id))
    .slice(0, CLOUD_RESIDENCY_LIMITS.candidateCellsPerRegion);
}

export interface CloudResidentFormation {
  readonly id: string;
  readonly direction: Vec3Like;
}

export interface CloudResident<T extends CloudResidentFormation> {
  readonly slot: number;
  readonly formation: T;
  opacity: number;
  targetOpacity: number;
}

export interface CloudResidencyStats {
  regionChanges: number;
  cellEvaluations: number;
  lastCellEvaluations: number;
  cachedCells: number;
  pendingCells: number;
  residentCount: number;
  submittedSlots: number;
}

interface CloudResidencyOptions<T extends CloudResidentFormation> {
  readonly grid: CloudCellGrid;
  readonly resolve: (cell: CloudCell) => T | null;
  readonly assign: (slot: number, formation: T) => void;
  readonly release: (slot: number) => void;
  readonly opacity: (slot: number, opacity: number) => void;
}

/** Stable slots, bounded negative-result cache, and same-clock temporal handoffs. */
export class CloudRegionResidency<T extends CloudResidentFormation> {
  readonly grid: CloudCellGrid;
  readonly capacity: number;
  readonly fadeStartMeters: number;
  readonly fadeEndMeters: number;
  readonly slots: Array<CloudResident<T> | undefined>;
  readonly stats: CloudResidencyStats = {
    regionChanges: 0, cellEvaluations: 0, lastCellEvaluations: 0,
    cachedCells: 0, pendingCells: 0, residentCount: 0, submittedSlots: 0,
  };
  private readonly options: CloudResidencyOptions<T>;
  private readonly cache = new Map<string, T | null>();
  private readonly residentById = new Map<string, CloudResident<T>>();
  private region?: CloudCell;
  private candidates: CloudCell[] = [];
  private pending: CloudCell[] = [];
  private previousDirection?: Vec3Like;
  private previousTime?: number;
  private previousEnabled?: boolean;
  private lastWorkTime?: number;

  constructor(options: CloudResidencyOptions<T>) {
    this.options = options;
    this.grid = options.grid;
    this.capacity = this.grid.layer === 'near' ? CLOUD_RESIDENCY_LIMITS.nearSlots : CLOUD_RESIDENCY_LIMITS.farSlots;
    this.fadeStartMeters = this.grid.cellMeters * (this.grid.layer === 'near'
      ? CLOUD_RESIDENCY_LIMITS.nearFadeStartCells : CLOUD_RESIDENCY_LIMITS.farFadeStartCells);
    this.fadeEndMeters = this.grid.cellMeters * (this.grid.layer === 'near'
      ? CLOUD_RESIDENCY_LIMITS.nearFadeEndCells : CLOUD_RESIDENCY_LIMITS.farFadeEndCells);
    this.slots = new Array(this.capacity);
  }

  get regionKey(): string { return this.region?.id ?? ''; }

  update(rawDirection: Vec3Like, rawTimeSeconds: number, enabled = true): boolean {
    const direction = normalized(rawDirection);
    const time = Number.isFinite(rawTimeSeconds) ? rawTimeSeconds : this.previousTime ?? 0;
    const elapsed = this.previousTime === undefined ? 0 : Math.max(0, time - this.previousTime);
    const sameDirection = this.previousDirection !== undefined && this.previousDirection.x === direction.x &&
      this.previousDirection.y === direction.y && this.previousDirection.z === direction.z;
    if (sameDirection && enabled === this.previousEnabled && (time === this.previousTime ||
        ((!enabled || this.pending.length === 0) && this.slots.every((resident) =>
          !resident || resident.opacity === resident.targetOpacity)))) {
      this.stats.lastCellEvaluations = 0;
      this.previousTime = time;
      return false;
    }
    const cold = this.region === undefined;
    if (enabled) {
      const candidate = cloudCellForDirection(this.grid, direction);
      if (!this.region || (candidate.id !== this.region.id &&
          cloudSurfaceDistanceMeters(direction, this.region.direction, this.grid.radiusMeters) >
            this.grid.cellMeters * CLOUD_RESIDENCY_LIMITS.regionHysteresisCells)) {
        this.region = candidate;
        this.stats.regionChanges += 1;
        this.candidates = cloudCellsAround(this.grid, candidate.direction,
          this.fadeEndMeters + this.grid.cellMeters * CLOUD_RESIDENCY_LIMITS.prefetchRingCells);
        const predicted = this.predictedDirection(direction, elapsed);
        this.pending = this.candidates.filter((cell) => !this.cache.has(cell.id)).sort((a, b) =>
          cloudSurfaceDistanceMeters(predicted, a.direction, this.grid.radiusMeters) -
            cloudSurfaceDistanceMeters(predicted, b.direction, this.grid.radiusMeters) || a.id.localeCompare(b.id));
      }
    }

    let evaluated = 0;
    if (enabled && (cold || time !== this.lastWorkTime)) {
      // A cold region is seeded once, normally above the atmosphere while the
      // orbital clouds are still visible. Further work is strictly incremental.
      const budget = cold ? this.capacity : CLOUD_RESIDENCY_LIMITS.newCellsPerLayerUpdate;
      while (evaluated < budget && this.pending.length) {
        const cell = this.pending.shift()!;
        if (this.cache.has(cell.id)) continue;
        this.cache.set(cell.id, this.options.resolve(cell));
        evaluated += 1;
      }
      this.lastWorkTime = time;
    }
    this.stats.cellEvaluations += evaluated;
    this.stats.lastCellEvaluations = evaluated;

    const desired: Array<{ formation: T; distance: number; opacity: number }> = [];
    if (enabled) for (const cell of this.candidates) {
      const formation = this.cache.get(cell.id);
      if (!formation) continue;
      const distance = cloudSurfaceDistanceMeters(direction, formation.direction, this.grid.radiusMeters);
      const amount = clamp((distance - this.fadeStartMeters) /
        (this.fadeEndMeters - this.fadeStartMeters), 0, 1);
      const opacity = 1 - amount * amount * (3 - 2 * amount);
      if (opacity > 0) desired.push({ formation, distance, opacity });
    }
    const retainedBias = this.grid.cellMeters * CLOUD_RESIDENCY_LIMITS.retainedPriorityCells;
    desired.sort((a, b) =>
      (a.distance - (this.residentById.has(a.formation.id) ? retainedBias : 0)) -
        (b.distance - (this.residentById.has(b.formation.id) ? retainedBias : 0)) ||
      a.formation.id.localeCompare(b.formation.id));
    desired.length = Math.min(desired.length, this.capacity);
    const targets = new Map(desired.map((entry) => [entry.formation.id, entry]));
    const step = elapsed / CLOUD_RESIDENCY_LIMITS.fadeSeconds;
    let membershipChanged = false;
    for (let index = 0; index < this.slots.length; index += 1) {
      const resident = this.slots[index];
      if (!resident) continue;
      resident.targetOpacity = targets.get(resident.formation.id)?.opacity ?? 0;
      const difference = resident.targetOpacity - resident.opacity;
      const next = Math.abs(difference) <= step
        ? resident.targetOpacity : resident.opacity + Math.sign(difference) * step;
      if (next !== resident.opacity) {
        resident.opacity = next;
        this.options.opacity(index, next);
      }
      if (!targets.has(resident.formation.id) && resident.opacity === 0) {
        this.options.release(index);
        this.residentById.delete(resident.formation.id);
        this.slots[index] = undefined;
        membershipChanged = true;
      }
    }
    for (const entry of desired) {
      if (this.residentById.has(entry.formation.id)) continue;
      const slot = this.slots.findIndex((resident) => resident === undefined);
      if (slot < 0) break;
      const resident: CloudResident<T> = { slot, formation: entry.formation,
        opacity: 0, targetOpacity: entry.opacity };
      this.slots[slot] = resident;
      this.residentById.set(entry.formation.id, resident);
      this.options.opacity(slot, 0);
      this.options.assign(slot, entry.formation);
      membershipChanged = true;
    }

    const protectedCells = new Set(this.candidates.map((cell) => cell.id));
    for (const key of this.cache.keys()) {
      if (this.cache.size <= CLOUD_RESIDENCY_LIMITS.cachedCellsPerLayer) break;
      if (!protectedCells.has(key) && !this.residentById.has(key)) this.cache.delete(key);
    }
    this.stats.cachedCells = this.cache.size;
    this.stats.pendingCells = this.pending.length;
    this.stats.residentCount = this.residentById.size;
    let lastSlot = this.slots.length - 1;
    while (lastSlot >= 0 && this.slots[lastSlot] === undefined) lastSlot -= 1;
    this.stats.submittedSlots = lastSlot + 1;
    this.previousDirection = direction;
    this.previousTime = time;
    this.previousEnabled = enabled;
    return membershipChanged;
  }

  private predictedDirection(direction: Vec3Like, elapsed: number): Vec3Like {
    if (!this.previousDirection || elapsed <= 0 || elapsed > 1) return direction;
    const dot = direction.x * this.previousDirection.x + direction.y * this.previousDirection.y +
      direction.z * this.previousDirection.z;
    const tangent = { x: direction.x * dot - this.previousDirection.x,
      y: direction.y * dot - this.previousDirection.y,
      z: direction.z * dot - this.previousDirection.z };
    const length = Math.hypot(tangent.x, tangent.y, tangent.z);
    if (length < 1e-12) return direction;
    const speed = cloudSurfaceDistanceMeters(direction, this.previousDirection, this.grid.radiusMeters) / elapsed;
    const lead = Math.min(this.grid.cellMeters * 1.5, speed * 0.8) / this.grid.radiusMeters;
    return normalized({ x: direction.x + tangent.x / length * lead,
      y: direction.y + tangent.y / length * lead,
      z: direction.z + tangent.z / length * lead });
  }
}
