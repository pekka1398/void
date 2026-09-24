import type {
  CockpitRadarContact,
  CockpitRadarKind,
  CockpitRadarSnapshot,
} from './CockpitRadar';

const MAXIMUM_HOLOGRAPHIC_CONTACTS = 32;
const ELEVATION_EPSILON = 1e-9;

export interface HolographicRadarOptions {
  /** Native SVG-space center of the actual ship-relative orbital plane. */
  readonly centerX?: number;
  readonly centerY?: number;
  /** Scope radii change presentation only; physical source meters remain intact. */
  readonly horizontalRadius?: number;
  readonly planeDepthRadius?: number;
  readonly heightRadius?: number;
}

export interface HolographicRadarContact {
  /** The exact descriptor-backed contact object from the authoritative snapshot. */
  readonly source: CockpitRadarContact;
  readonly id: string;
  readonly name: string;
  readonly kind: CockpitRadarKind;
  readonly parentId?: string;
  readonly color: string;
  readonly distanceMeters: number;
  readonly centerDistanceMeters: number;
  readonly elevationRadians: number;
  readonly selected: boolean;
  readonly behind: boolean;
  readonly clipped: boolean;
  /** Actual planar footprint before its signed vertical stem is applied. */
  readonly planeX: number;
  readonly planeY: number;
  /** Native SVG-space tip of the same genuine raised or lowered body. */
  readonly x: number;
  readonly y: number;
  /** Genuine signed body height in the same bounded logarithmic radar frame. */
  readonly height: number;
  readonly heightPixels: number;
  readonly stemLength: number;
  readonly above: boolean;
  /** Stable actual-plane depth, used only for bounded painter ordering. */
  readonly depthOrder: number;
}

export interface HolographicRadarSnapshot {
  readonly systemId: string;
  readonly systemName: string;
  readonly timeSeconds: number;
  readonly rangeMeters: number;
  readonly headingRadians: number;
  readonly totalActualContacts: number;
  readonly selectedTargetId?: string;
  readonly selectedDistanceMeters?: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly horizontalRadius: number;
  readonly planeDepthRadius: number;
  readonly heightRadius: number;
  readonly contacts: readonly HolographicRadarContact[];
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function signedPhysicalHeight(contact: CockpitRadarContact): number {
  const exactHeight = contact.height;
  if (Number.isFinite(exactHeight)) return Math.max(-1, Math.min(1, exactHeight));

  // Compatibility with persisted/older genuine contact snapshots. The actual
  // signed elevation remains meaningful even for a body directly overhead,
  // where its planar x/y footprint is necessarily the ship's origin.
  return Math.max(-1, Math.min(1, Math.sin(contact.elevationRadians)));
}

function validActualContact(contact: CockpitRadarContact): boolean {
  return typeof contact.id === 'string' && contact.id.length > 0 &&
    Number.isFinite(contact.x) && Number.isFinite(contact.y) &&
    Number.isFinite(contact.elevationRadians) &&
    Number.isFinite(contact.distanceMeters) && contact.distanceMeters >= 0 &&
    Number.isFinite(contact.centerDistanceMeters) && contact.centerDistanceMeters >= 0;
}

/**
 * Project actual descriptor-backed system bodies onto an original 3D scope.
 *
 * Ship-right and ship-forward come from the same real cockpit radar frame; a
 * signed, full-distance vertical component lifts the identical real contact
 * above or below the isometric plane. This helper never evaluates an orbit,
 * creates a celestial object, changes physical range, or advances simulation
 * time. The native-resolution DOM/SVG presentation adds no renderer passes.
 */
export function projectHolographicRadar(
  snapshot: CockpitRadarSnapshot,
  options: HolographicRadarOptions = {},
): HolographicRadarSnapshot {
  const centerX = finiteOr(options.centerX, 120);
  const centerY = finiteOr(options.centerY, 94);
  const horizontalRadius = positiveOr(options.horizontalRadius, 88);
  const planeDepthRadius = positiveOr(options.planeDepthRadius, 31);
  const heightRadius = positiveOr(options.heightRadius, 39);
  const seen = new Set<string>();
  const retained: CockpitRadarContact[] = [];

  for (const contact of snapshot.contacts) {
    if (!validActualContact(contact) || seen.has(contact.id)) continue;
    if (retained.length < MAXIMUM_HOLOGRAPHIC_CONTACTS) {
      retained.push(contact);
      seen.add(contact.id);
      continue;
    }

    // If an external caller exceeds the same physical 32-body scope bound,
    // retain the genuinely selected body rather than synthesizing a marker.
    if (contact.selected && !retained.some((candidate) => candidate.selected)) {
      const replaced = retained[retained.length - 1];
      if (replaced) seen.delete(replaced.id);
      retained[retained.length - 1] = contact;
      seen.add(contact.id);
    }
  }

  const contacts = retained.map((source): HolographicRadarContact => {
    const height = signedPhysicalHeight(source);
    const planeX = centerX + source.x * horizontalRadius;
    const planeY = centerY + source.y * planeDepthRadius;
    const heightPixels = height * heightRadius;

    return {
      source,
      id: source.id,
      name: source.name,
      kind: source.kind,
      ...(source.parentId !== undefined ? { parentId: source.parentId } : {}),
      color: source.color,
      distanceMeters: source.distanceMeters,
      centerDistanceMeters: source.centerDistanceMeters,
      elevationRadians: source.elevationRadians,
      selected: source.selected,
      behind: source.behind,
      clipped: source.clipped,
      planeX,
      planeY,
      x: planeX,
      y: planeY - heightPixels,
      height,
      heightPixels,
      stemLength: Math.abs(heightPixels),
      above: height > ELEVATION_EPSILON,
      depthOrder: source.y - height * 0.12,
    };
  });

  contacts.sort((first, second) => (
    first.depthOrder - second.depthOrder ||
    Number(first.selected) - Number(second.selected) ||
    first.id.localeCompare(second.id)
  ));

  return {
    systemId: snapshot.systemId,
    systemName: snapshot.systemName,
    timeSeconds: snapshot.timeSeconds,
    rangeMeters: snapshot.rangeMeters,
    headingRadians: snapshot.headingRadians,
    totalActualContacts: snapshot.totalActualContacts,
    ...(snapshot.selectedTargetId !== undefined
      ? { selectedTargetId: snapshot.selectedTargetId }
      : {}),
    ...(snapshot.selectedDistanceMeters !== undefined
      ? { selectedDistanceMeters: snapshot.selectedDistanceMeters }
      : {}),
    centerX,
    centerY,
    horizontalRadius,
    planeDepthRadius,
    heightRadius,
    contacts,
  };
}
