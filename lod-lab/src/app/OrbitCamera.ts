import type { Vec3 } from '../lod/Vec3';

export interface OrbitCameraPose {
  /** Body-fixed meters. */
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
}

export interface OrbitCameraOptions {
  readonly radiusMeters: number;
  /** Ground height (above radius) under a body-fixed unit direction. */
  readonly groundHeightMeters: (direction: Vec3) => number;
  readonly minClearanceMeters?: number;
  readonly maxAltitudeMeters?: number;
}

/**
 * Orbits a body-fixed planet. State is a unit sub-camera direction `p` with an
 * orthonormal tangent frame (`north` = screen-up when looking straight down),
 * so moving over the poles has no singularity. Height is kept as clearance
 * above the real ground, so low passes follow the terrain.
 */
export class OrbitCamera {
  private p: Vec3;
  private north: Vec3;
  private clearance: number;
  /** 0 = straight down at the planet center; approaching π/2 = looking at the horizon. */
  private tilt = 0;
  private readonly minClearance: number;
  private readonly maxAltitude: number;

  constructor(private readonly options: OrbitCameraOptions, start: Vec3, altitudeMeters: number) {
    this.p = normalize(start);
    this.north = normalize(reject({ x: 0, y: 1, z: 0 }, this.p));
    this.minClearance = options.minClearanceMeters ?? 2;
    this.maxAltitude = options.maxAltitudeMeters ?? options.radiusMeters * 30;
    this.clearance = altitudeMeters;
  }

  get clearanceMeters(): number { return this.clearance; }
  get tiltRadians(): number { return this.tilt; }
  get subPoint(): Vec3 { return { ...this.p }; }

  /** Move over the ground; distances are screen-proportional so a drag "grabs" the surface. */
  pan(forwardMeters: number, rightMeters: number): void {
    const east = this.east();
    const a = forwardMeters / this.options.radiusMeters;
    const b = rightMeters / this.options.radiusMeters;
    // Parallel transport along the forward great circle, then the sideways one.
    let p = add(scale(this.p, Math.cos(a)), scale(this.north, Math.sin(a)));
    let north = sub(scale(this.north, Math.cos(a)), scale(this.p, Math.sin(a)));
    const p2 = add(scale(p, Math.cos(b)), scale(east, Math.sin(b)));
    p = normalize(p2);
    north = normalize(reject(north, p));
    this.p = p;
    this.north = north;
  }

  /** Rotate the view heading about the local vertical and change tilt. */
  turn(headingRadians: number, tiltRadians: number): void {
    const east = this.east();
    this.north = normalize(add(scale(this.north, Math.cos(headingRadians)), scale(east, Math.sin(headingRadians))));
    this.tilt = Math.min(Math.PI / 2 - 0.01, Math.max(0, this.tilt + tiltRadians));
  }

  /** Multiplicative zoom on clearance: equal wheel steps feel the same at 5 m and 5000 km. */
  zoom(factor: number): void {
    this.clearance = Math.min(this.maxAltitude, Math.max(this.minClearance, this.clearance * factor));
  }

  setClearance(meters: number): void {
    this.clearance = Math.min(this.maxAltitude, Math.max(this.minClearance, meters));
  }

  /** Meters of ground motion for one screen pixel at the current view. */
  metersPerPixel(fovYRadians: number, viewportHeightPixels: number): number {
    return Math.max(0.05, this.clearance) * 2 * Math.tan(fovYRadians / 2) / viewportHeightPixels;
  }

  pose(): OrbitCameraPose {
    const ground = Math.max(0, this.options.groundHeightMeters(this.p));
    const r = this.options.radiusMeters + ground + this.clearance;
    const down = scale(this.p, -1);
    const forward = add(scale(down, Math.cos(this.tilt)), scale(this.north, Math.sin(this.tilt)));
    const up = add(scale(this.p, Math.sin(this.tilt)), scale(this.north, Math.cos(this.tilt)));
    return { position: scale(this.p, r), forward: normalize(forward), up: normalize(up) };
  }

  private east(): Vec3 {
    return cross(this.north, this.p);
  }
}

function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(a: Vec3, s: number): Vec3 { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a.x, a.y, a.z);
  if (!Number.isFinite(length) || length < 1e-9) throw new Error('Cannot normalize a zero or invalid vector');
  return scale(a, 1 / length);
}
/** Component of `v` perpendicular to unit `n`; parallel input is invalid. */
function reject(v: Vec3, n: Vec3): Vec3 {
  const r = sub(v, scale(n, dot(v, n)));
  if (Math.hypot(r.x, r.y, r.z) < 1e-9) throw new Error('Orbit camera tangent axis is parallel to radial direction');
  return r;
}
