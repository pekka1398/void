import type { Vec3 } from '../lod/Vec3';

export interface OrbitCameraPose {
  /** Body-fixed meters. */
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
}

export interface OrbitCameraOptions {
  readonly maxDistanceMeters: number;
}

/**
 * Orbits a body-fixed planet. State is a unit sub-camera direction `p` with an
 * orthonormal tangent frame (`north` = screen-up when looking straight down),
 * so moving over the poles has no singularity. Zoom scales distance from the
 * planet center directly and never samples terrain or the reference sphere.
 */
export class OrbitCamera {
  private p: Vec3;
  private north: Vec3;
  private offset: Vec3 = { x: 0, y: 0, z: 0 };
  private distance: number;
  /** 0 = straight down at the planet center; approaching π/2 = looking at the horizon. */
  private tilt = 0;
  constructor(private readonly options: OrbitCameraOptions, start: Vec3, distanceMeters: number) {
    this.p = normalize(start);
    this.north = normalize(reject({ x: 0, y: 1, z: 0 }, this.p));
    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) throw new Error(`OrbitCamera.ts: invalid initial center distance=${distanceMeters}`);
    if (!Number.isFinite(options.maxDistanceMeters) || options.maxDistanceMeters <= 0) throw new Error(`OrbitCamera.ts: invalid max center distance=${options.maxDistanceMeters}`);
    this.distance = distanceMeters;
  }

  get distanceMeters(): number { return this.distance; }
  get tiltRadians(): number { return this.tilt; }
  get subPoint(): Vec3 { return { ...this.p }; }

  /** Translate in the camera's view plane; neither forward nor up rotates. */
  panScreen(dxPixels: number, dyPixels: number, fovYRadians: number, viewportHeightPixels: number): void {
    if (![dxPixels, dyPixels, fovYRadians, viewportHeightPixels].every(Number.isFinite) || viewportHeightPixels <= 0) {
      throw new Error(`OrbitCamera.ts panScreen: invalid dx=${dxPixels} dy=${dyPixels} fov=${fovYRadians} height=${viewportHeightPixels}`);
    }
    const pose = this.pose();
    const right = normalize(cross(pose.forward, pose.up));
    const meters = this.metersPerPixel(fovYRadians, viewportHeightPixels);
    this.offset = add(this.offset, add(scale(right, -dxPixels * meters), scale(pose.up, dyPixels * meters)));
  }

  /** Rotate camera position and orientation around the planet's actual center. */
  orbitAroundCenter(horizontalRadians: number, verticalRadians: number): void {
    if (!Number.isFinite(horizontalRadians) || !Number.isFinite(verticalRadians)) {
      throw new Error(`OrbitCamera.ts orbitAroundCenter: invalid angles horizontal=${horizontalRadians}; vertical=${verticalRadians}`);
    }
    const worldUp = { x: 0, y: 1, z: 0 };
    this.p = rotate(this.p, worldUp, horizontalRadians);
    this.north = rotate(this.north, worldUp, horizontalRadians);
    this.offset = rotate(this.offset, worldUp, horizontalRadians);
    const right = normalize(cross(this.north, this.p));
    this.p = normalize(rotate(this.p, right, verticalRadians));
    this.north = normalize(rotate(this.north, right, verticalRadians));
    this.offset = rotate(this.offset, right, verticalRadians);
  }

  /** Rotate the view heading about the local vertical and change tilt. */
  turn(headingRadians: number, tiltRadians: number): void {
    const east = this.east();
    this.north = normalize(add(scale(this.north, Math.cos(headingRadians)), scale(east, Math.sin(headingRadians))));
    this.tilt = Math.min(Math.PI / 2 - 0.01, Math.max(0, this.tilt + tiltRadians));
  }

  /** Multiplicative zoom on distance from the planet center. */
  zoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`OrbitCamera.ts zoom: invalid factor=${factor}; centerDistance=${this.distance}`);
    }
    this.setDistance(this.distance * factor);
  }

  setDistance(meters: number): void {
    if (!Number.isFinite(meters) || meters <= 0) throw new Error(`OrbitCamera.ts setDistance: invalid center distance=${meters}`);
    const nextDistance = Math.min(this.options.maxDistanceMeters, meters);
    // Scale the full camera position about the planet center. This preserves
    // the screen location of the center after a left-drag translation.
    this.offset = scale(this.offset, nextDistance / this.distance);
    this.distance = nextDistance;
  }

  /** Meters of camera pan for one screen pixel at the current center distance. */
  metersPerPixel(fovYRadians: number, viewportHeightPixels: number): number {
    return this.distance * 2 * Math.tan(fovYRadians / 2) / viewportHeightPixels;
  }

  pose(): OrbitCameraPose {
    const r = this.distance;
    const down = scale(this.p, -1);
    const forward = add(scale(down, Math.cos(this.tilt)), scale(this.north, Math.sin(this.tilt)));
    const up = add(scale(this.p, Math.sin(this.tilt)), scale(this.north, Math.cos(this.tilt)));
    return { position: add(scale(this.p, r), this.offset), forward: normalize(forward), up: normalize(up) };
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
function rotate(value: Vec3, axis: Vec3, radians: number): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return add(add(scale(value, c), scale(cross(axis, value), s)), scale(axis, dot(axis, value) * (1 - c)));
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
