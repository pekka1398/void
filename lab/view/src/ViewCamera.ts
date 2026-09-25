import { cross, dot, length, normalize, type Vec3 } from '../../orbit/src/orbit/Vec3';

/**
 * single: one view; zooming out fades the map (orbits, labels) in and turns
 * the camera from the surface frame to the inertial one.
 * split: KSP's two views; M switches between flight and map, each with its
 * own zoom range, and the switch is instant.
 */
export type ViewMode = 'single' | 'split';

/** Map elements fade in between these zoom scales, in radii of the reference body (log-distance smoothstep). */
export const MAP_FADE_RADII = [0.02, 0.2] as const;
/**
 * The camera co-rotates with the surface below the first focus altitude and
 * is inertial above the second, in radii of the reference body (KSP's flight
 * camera switches from surface to orbital at a fixed altitude instead).
 */
export const SURFACE_LOCK_RADII = [0.004, 0.012] as const;
/** Split mode: KSP FlightCamera.maxDistance, metres. */
export const FLIGHT_MAX_DISTANCE = 150_000;
/** Split mode: KSP PlanetariumCamera.minDistance (3) times ScaledSpace.scaleFactor (6000), metres. */
export const MAP_MIN_DISTANCE = 18_000;
/** The view direction keeps at least this angle from straight up or down, radians. */
export const MIN_ANGLE_FROM_UP = 0.02;
const RADIANS_PER_PIXEL = 0.005;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) throw new RangeError(`smoothstep: edges ${edge0}, ${edge1}`);
  if (!Number.isFinite(x)) throw new RangeError(`smoothstep: x=${x}`);
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of the map is shown in single mode, 0..1. zoomScale is the
 * camera's distance from what it looks at: from the vessel, or from the
 * surface of a focused body.
 */
export function mapWeightFor(zoomScale: number, referenceRadius: number): number {
  if (!(referenceRadius > 0)) throw new RangeError(`mapWeightFor: radius ${referenceRadius}`);
  if (zoomScale <= 0) return 0;
  return smoothstep(Math.log(MAP_FADE_RADII[0] * referenceRadius), Math.log(MAP_FADE_RADII[1] * referenceRadius), Math.log(zoomScale));
}

/** Fraction of the reference body's spin the camera direction follows, 0..1. */
export function corotationWeight(mapWeight: number, focusAltitude: number, referenceRadius: number): number {
  if (!(mapWeight >= 0 && mapWeight <= 1)) throw new RangeError(`corotationWeight: map weight ${mapWeight}`);
  const high = smoothstep(SURFACE_LOCK_RADII[0] * referenceRadius, SURFACE_LOCK_RADII[1] * referenceRadius, focusAltitude);
  return (1 - mapWeight) * (1 - high);
}

/** Rodrigues rotation of v about a unit axis. */
export function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle), k = dot(axis, v) * (1 - c);
  const a = cross(axis, v);
  return { x: v.x * c + a.x * s + axis.x * k, y: v.y * c + a.y * s + axis.y * k, z: v.z * c + a.z * s + axis.z * k };
}

/** A unit vector perpendicular to unit a. */
export function perpendicular(a: Vec3): Vec3 {
  return normalize(cross(a, Math.abs(a.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }));
}

/**
 * Turn unit a toward unit b by fraction s of the angle between them. Opposite
 * vectors have no unique great circle; they turn about perpendicular(a).
 */
export function slerpUnit(a: Vec3, b: Vec3, s: number): Vec3 {
  if (!(s >= 0 && s <= 1)) throw new RangeError(`slerpUnit: s=${s}`);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  if (angle === 0) return a;
  const axis = cross(a, b);
  return rotate(a, length(axis) > 1e-12 ? normalize(axis) : perpendicular(a), angle * s);
}

/**
 * Camera orbiting its focus. The direction (focus to camera, unit) is kept in
 * the inertial ecliptic frame; co-rotation with a surface is applied by
 * turning it with the body. Dragging turns it about the current up vector
 * (azimuth) and toward or away from it (elevation), so the same state serves
 * the flight view (up = local vertical) and the map (up = the body's north).
 */
export class OrbitCamera {
  direction: Vec3;
  distance: number;

  constructor(direction: Vec3, distance: number) {
    if (Math.abs(length(direction) - 1) > 1e-9) throw new RangeError(`OrbitCamera: direction not unit ${JSON.stringify(direction)}`);
    if (!(distance > 0)) throw new RangeError(`OrbitCamera: distance ${distance}`);
    this.direction = direction;
    this.distance = distance;
  }

  /** Pointer drag in pixels; dragging down raises the camera. */
  drag(dxPixels: number, dyPixels: number, up: Vec3): void {
    this.clampToUp(up);
    this.direction = normalize(rotate(this.direction, up, -dxPixels * RADIANS_PER_PIXEL));
    // Elevation is set as an angle from up, clamped before turning, so a long drag stops at the pole instead of wrapping over it.
    const fromUp = Math.acos(Math.max(-1, Math.min(1, dot(up, this.direction))));
    const target = Math.max(MIN_ANGLE_FROM_UP, Math.min(Math.PI - MIN_ANGLE_FROM_UP, fromUp - dyPixels * RADIANS_PER_PIXEL));
    // Rotating up about (up x direction) turns it toward the direction.
    this.direction = normalize(rotate(up, normalize(cross(up, this.direction)), target));
  }

  zoom(factor: number, minDistance: number, maxDistance: number): void {
    if (!(factor > 0)) throw new RangeError(`OrbitCamera.zoom: factor ${factor}`);
    this.distance = this.clampDistance(this.distance * factor, minDistance, maxDistance);
  }

  clampDistance(value: number, minDistance: number, maxDistance: number): number {
    if (!(minDistance > 0 && maxDistance >= minDistance)) throw new RangeError(`OrbitCamera: distance range ${minDistance}..${maxDistance}`);
    return Math.max(minDistance, Math.min(maxDistance, value));
  }

  /** Turn with a spinning body: angle about its unit spin axis. */
  corotate(axis: Vec3, angle: number): void {
    this.direction = normalize(rotate(this.direction, axis, angle));
  }

  /** Keep the direction at least MIN_ANGLE_FROM_UP away from up and down, keeping its azimuth. */
  clampToUp(up: Vec3): void {
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(up, this.direction))));
    const clamped = Math.max(MIN_ANGLE_FROM_UP, Math.min(Math.PI - MIN_ANGLE_FROM_UP, angle));
    if (clamped === angle) return;
    const side = cross(up, this.direction);
    // Rotating up about (up x direction) turns it toward the direction.
    this.direction = normalize(rotate(up, length(side) > 1e-12 ? normalize(side) : perpendicular(up), clamped));
  }
}

/** Nearest camera distance from the vessel, metres (the vessel is about 6 m long). */
export const VESSEL_MIN_DISTANCE = 8;
/** Nearest camera distance from a focused body's centre, in its radii. */
export const BODY_MIN_RADII = 1.02;
/** Farthest camera distance, metres: beyond the outermost planet. */
export const MAX_DISTANCE = 2e13;

/** What the camera looks at, in the inertial ecliptic frame. */
export interface FocusGeometry {
  kind: 'vessel' | 'body';
  /** Unit vector from the reference body's centre to the vessel; null for a body focus. */
  radial: Vec3 | null;
  /** The reference body's spin axis (unit). */
  north: Vec3;
  referenceRadius: number;
  /** Vessel altitude above the reference body's radius; 0 for a body focus, which counts as on its surface. */
  altitude: number;
  /** The focused body's radius; 0 for the vessel. */
  focusRadius: number;
}

export interface ViewState {
  /** 0 = flight view, 1 = map: orbit lines and labels are drawn at this opacity. */
  mapWeight: number;
  /** Fraction of the reference body's spin the camera follows. */
  corotation: number;
  /** Camera up (unit): local vertical in flight, the body's north on the map. */
  up: Vec3;
  minDistance: number;
  maxDistance: number;
}

/**
 * The per-frame view decisions for a camera at `distance` from the focus.
 * single: everything follows the zoom. split: flight (mapOn false) or map (mapOn true).
 */
export function viewState(mode: ViewMode, mapOn: boolean, focus: FocusGeometry, distance: number): ViewState {
  if (focus.kind === 'vessel' ? focus.radial === null || focus.focusRadius !== 0 : focus.radial !== null || !(focus.focusRadius > 0)) {
    throw new Error(`viewState: inconsistent ${focus.kind} focus ${JSON.stringify(focus)}`);
  }
  const nearest = focus.kind === 'vessel' ? VESSEL_MIN_DISTANCE : focus.focusRadius * BODY_MIN_RADII;
  let minDistance: number, maxDistance: number, mapWeight: number;
  if (mode === 'single') {
    if (mapOn) throw new Error('viewState: single mode has no map switch');
    minDistance = nearest;
    maxDistance = MAX_DISTANCE;
    const clamped = Math.max(minDistance, Math.min(maxDistance, distance));
    mapWeight = mapWeightFor(clamped - focus.focusRadius, focus.referenceRadius);
  } else if (mapOn) {
    minDistance = Math.max(nearest, focus.focusRadius + MAP_MIN_DISTANCE);
    maxDistance = MAX_DISTANCE;
    mapWeight = 1;
  } else {
    if (focus.kind !== 'vessel') throw new Error('viewState: the split flight view looks only at the vessel');
    minDistance = nearest;
    maxDistance = FLIGHT_MAX_DISTANCE;
    mapWeight = 0;
  }
  const up = focus.radial ? slerpUnit(focus.radial, focus.north, mapWeight) : focus.north;
  return { mapWeight, corotation: corotationWeight(mapWeight, focus.altitude, focus.referenceRadius), up, minDistance, maxDistance };
}
