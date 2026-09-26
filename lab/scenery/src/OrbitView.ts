import type { Vec3 } from './Atmosphere';

/**
 * lab/lod's OrbitCamera, with the same state and the same mouse mapping
 * (left drag pans, right drag orbits the planet centre, Shift + left drag
 * turns, the wheel zooms), made to work from space down to the ground:
 *
 * - Zoom and pan scale with the height above the surface under the camera, not
 *   the distance to the centre, so a wheel notch at 2 m moves centimetres and at
 *   20,000 km moves thousands of kilometres.
 * - Orbiting slows with height the same way (at most lab/lod's 0.005 rad per pixel).
 * - Tilt runs from straight down (0) past the horizon (π/2) to nearly straight
 *   up, so the sky can be looked at from the ground.
 * - The camera never goes below `MIN_HEIGHT` above the surface.
 *
 * State: the unit direction `p` of the point the camera orbits over, a unit
 * tangent `north` (screen up when looking straight down; no pole singularity),
 * a pan offset in metres, the distance from the centre and the tilt.
 */
export class OrbitView {
  static readonly MIN_HEIGHT = 1.5;
  private p: Vec3;
  private north: Vec3;
  private offset: Vec3 = { x: 0, y: 0, z: 0 };
  private distance: number;
  private tilt: number;

  constructor(start: Vec3, distanceMeters: number, tiltRadians: number, readonly maxDistanceMeters: number) {
    this.p = normalize(start);
    this.north = normalize(reject({ x: 0, y: 0, z: 1 }, this.p));
    if (!(distanceMeters > 0) || !(maxDistanceMeters > 0)) throw new RangeError(`OrbitView: distance=${distanceMeters}, max=${maxDistanceMeters}`);
    this.distance = distanceMeters;
    this.tilt = clampTilt(tiltRadians);
  }

  get tiltRadians(): number { return this.tilt; }

  pose(): { position: Vec3; forward: Vec3; up: Vec3 } {
    const down = scale(this.p, -1);
    const forward = add(scale(down, Math.cos(this.tilt)), scale(this.north, Math.sin(this.tilt)));
    const up = add(scale(this.p, Math.sin(this.tilt)), scale(this.north, Math.cos(this.tilt)));
    return { position: add(scale(this.p, this.distance), this.offset), forward: normalize(forward), up: normalize(up) };
  }

  /** Right, up and backward (three.js camera axes) in body-fixed axes. */
  basis(): { right: Vec3; up: Vec3; back: Vec3 } {
    const { forward, up } = this.pose();
    return { right: normalize(cross(forward, up)), up, back: scale(forward, -1) };
  }

  /** Left drag: translate in the view plane, `height` metres of travel per screen height at a 1:1 scale. */
  panScreen(dxPixels: number, dyPixels: number, fovYRadians: number, viewportHeightPixels: number, height: number): void {
    finite('panScreen', dxPixels, dyPixels, fovYRadians, viewportHeightPixels, height);
    const { forward, up } = this.pose();
    const right = normalize(cross(forward, up));
    const meters = (height * 2 * Math.tan(fovYRadians / 2)) / viewportHeightPixels;
    this.offset = add(this.offset, add(scale(right, -dxPixels * meters), scale(up, dyPixels * meters)));
  }

  /** Right drag: turn the camera's position and orientation about the planet centre (the pole, then the screen's horizontal). */
  orbitAroundCenter(horizontalRadians: number, verticalRadians: number): void {
    finite('orbitAroundCenter', horizontalRadians, verticalRadians);
    const pole = { x: 0, y: 0, z: 1 };
    this.p = rotate(this.p, pole, horizontalRadians);
    this.north = rotate(this.north, pole, horizontalRadians);
    this.offset = rotate(this.offset, pole, horizontalRadians);
    const right = normalize(cross(this.north, this.p));
    this.p = normalize(rotate(this.p, right, verticalRadians));
    this.north = normalize(rotate(this.north, right, verticalRadians));
    this.offset = rotate(this.offset, right, verticalRadians);
  }

  /** Shift + left drag: turn the heading about the local vertical and change the tilt. */
  turn(headingRadians: number, tiltRadians: number): void {
    finite('turn', headingRadians, tiltRadians);
    const east = cross(this.north, this.p);
    this.north = normalize(add(scale(this.north, Math.cos(headingRadians)), scale(east, Math.sin(headingRadians))));
    this.tilt = clampTilt(this.tilt + tiltRadians);
  }

  /**
   * Scale the camera's whole position about the planet centre until it is at `radius` from it
   * (the pan offset scales with it, so the planet centre stays where it is on screen).
   */
  setRadius(radius: number): void {
    finite('setRadius', radius);
    const position = this.pose().position;
    const current = Math.hypot(position.x, position.y, position.z);
    const next = Math.min(this.maxDistanceMeters, radius);
    this.offset = scale(this.offset, next / current);
    this.distance *= next / current;
  }

  /** Put the camera over `direction`, `radius` from the centre, heading `headingRadians` from true north, with no pan. */
  place(direction: Vec3, radius: number, headingRadians: number, tiltRadians: number): void {
    this.p = normalize(direction);
    const north = normalize(reject({ x: 0, y: 0, z: 1 }, this.p));
    const east = cross(north, this.p);
    this.north = normalize(add(scale(north, Math.cos(headingRadians)), scale(east, Math.sin(headingRadians))));
    this.offset = { x: 0, y: 0, z: 0 };
    this.distance = radius;
    this.tilt = clampTilt(tiltRadians);
  }
}

/** Straight down to 0.01 rad short of straight up. */
function clampTilt(tilt: number): number { return Math.min(Math.PI - 0.01, Math.max(0, tilt)); }

function finite(where: string, ...values: number[]): void {
  if (!values.every(Number.isFinite)) throw new RangeError(`OrbitView.${where}: ${values.join(', ')}`);
}
function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(a: Vec3, s: number): Vec3 { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function rotate(value: Vec3, axis: Vec3, radians: number): Vec3 {
  const c = Math.cos(radians), s = Math.sin(radians);
  return add(add(scale(value, c), scale(cross(axis, value), s)), scale(axis, dot(axis, value) * (1 - c)));
}
function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a.x, a.y, a.z);
  if (!Number.isFinite(length) || length < 1e-9) throw new Error(`OrbitView: cannot normalize ${JSON.stringify(a)}`);
  return scale(a, 1 / length);
}
/** Component of `v` perpendicular to unit `n`. */
function reject(v: Vec3, n: Vec3): Vec3 {
  const r = sub(v, scale(n, dot(v, n)));
  // Over a pole, grid north runs down the prime meridian (as lab/navball does).
  if (Math.hypot(r.x, r.y, r.z) < 1e-12) return n.z > 0 ? { x: -1, y: 0, z: 0 } : { x: 1, y: 0, z: 0 };
  return r;
}
