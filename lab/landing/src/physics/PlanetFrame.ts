import { bodyOrientation, type CelestialBody, type Ephemeris, type Vec3 } from '../orbitCore';

export interface FrameState { position: Vec3; velocity: Vec3 }

/**
 * The planet's rotating, body-fixed frame (z = spin axis, x = prime meridian,
 * origin at the planet's centre), as a frame to do physics in. The ground is
 * at rest here; a moving object feels, besides gravity, the fictitious
 * accelerations of the rotation (constant spin, so no Euler term):
 *   centrifugal  -w x (w x r)      Coriolis  -2 w x v
 * and, because the origin falls freely with the planet, only the tidal part
 * of other bodies' gravity.
 */
export class PlanetFrame {
  readonly ephemeris: Ephemeris;
  readonly body: CelestialBody;
  /** Spin rate about body-fixed +z, rad/s. */
  readonly omega: number;
  private readonly positions: Float64Array;

  constructor(ephemeris: Ephemeris, bodyIndex: number) {
    const body = ephemeris.bodies[bodyIndex];
    if (!body) throw new RangeError(`PlanetFrame: body ${bodyIndex}`);
    this.ephemeris = ephemeris;
    this.body = body;
    this.omega = (2 * Math.PI) / body.rotation.periodSeconds;
    this.positions = new Float64Array(ephemeris.bodyCount * 3);
  }

  /** Barycentric inertial state to body-fixed: r = R^T (p - c), v = R^T (u - c') - w x r. */
  toBodyFixed(t: number, inertial: FrameState): FrameState {
    const axes = bodyOrientation(this.body, t);
    const c = this.ephemeris.bodyState(this.body.index, t);
    const dp = sub3(inertial.position, c.position), du = sub3(inertial.velocity, c.velocity);
    const r = { x: dot3(dp, axes.x), y: dot3(dp, axes.y), z: dot3(dp, axes.z) };
    const u = { x: dot3(du, axes.x), y: dot3(du, axes.y), z: dot3(du, axes.z) };
    const w = this.omega;
    return { position: r, velocity: { x: u.x + w * r.y, y: u.y - w * r.x, z: u.z } };
  }

  /** Body-fixed state to barycentric inertial: p = c + R r, u = c' + R (v + w x r). */
  toInertial(t: number, local: FrameState): FrameState {
    const axes = bodyOrientation(this.body, t);
    const c = this.ephemeris.bodyState(this.body.index, t);
    const r = local.position, w = this.omega;
    const v = { x: local.velocity.x - w * r.y, y: local.velocity.y + w * r.x, z: local.velocity.z };
    const rotate = (a: Vec3): Vec3 => ({
      x: a.x * axes.x.x + a.y * axes.y.x + a.z * axes.z.x,
      y: a.x * axes.x.y + a.y * axes.y.y + a.z * axes.z.y,
      z: a.x * axes.x.z + a.y * axes.y.z + a.z * axes.z.z,
    });
    const p = rotate(r), q = rotate(v);
    return {
      position: { x: c.position.x + p.x, y: c.position.y + p.y, z: c.position.z + p.z },
      velocity: { x: c.velocity.x + q.x, y: c.velocity.y + q.y, z: c.velocity.z + q.z },
    };
  }

  /** Acceleration of a free particle at body-fixed (r, v) at time t, contacts excluded. */
  acceleration(t: number, r: Vec3, v: Vec3): Vec3 {
    const b = this.body;
    const r2 = r.x * r.x + r.y * r.y + r.z * r.z;
    const rl = Math.sqrt(r2);
    // Own gravity: point mass plus J2 about +z (same law as VesselPropagator).
    let s = -b.gm / (r2 * rl);
    let ax = r.x * s, ay = r.y * s, az = r.z * s;
    if (b.j2 !== 0) {
      const c = 1.5 * b.j2 * b.gm * b.j2ReferenceRadiusMeters ** 2;
      const f = c / (r2 * r2 * rl);
      const radial = f * ((5 * r.z * r.z) / r2 - 1);
      ax += radial * r.x; ay += radial * r.y; az += radial * r.z - 2 * f * r.z;
    }
    // Other bodies: their pull here minus their pull on the planet's centre.
    if (this.ephemeris.bodyCount > 1) {
      const axes = bodyOrientation(b, t);
      this.ephemeris.positionsAt(t, this.positions);
      const P = this.positions, i0 = b.index * 3;
      const cx = P[i0]!, cy = P[i0 + 1]!, cz = P[i0 + 2]!;
      // The particle in inertial axes, relative to the planet's centre.
      const px = r.x * axes.x.x + r.y * axes.y.x + r.z * axes.z.x;
      const py = r.x * axes.x.y + r.y * axes.y.y + r.z * axes.z.y;
      const pz = r.x * axes.x.z + r.y * axes.y.z + r.z * axes.z.z;
      let tx = 0, ty = 0, tz = 0;
      this.ephemeris.bodies.forEach((o, k) => {
        if (k === b.index) return;
        const ox = P[k * 3]! - cx, oy = P[k * 3 + 1]! - cy, oz = P[k * 3 + 2]! - cz;
        const dx = ox - px, dy = oy - py, dz = oz - pz;
        const d2 = dx * dx + dy * dy + dz * dz, o2 = ox * ox + oy * oy + oz * oz;
        const sd = o.gm / (d2 * Math.sqrt(d2)), so = o.gm / (o2 * Math.sqrt(o2));
        tx += dx * sd - ox * so; ty += dy * sd - oy * so; tz += dz * sd - oz * so;
      });
      ax += tx * axes.x.x + ty * axes.x.y + tz * axes.x.z;
      ay += tx * axes.y.x + ty * axes.y.y + tz * axes.y.z;
      az += tx * axes.z.x + ty * axes.z.y + tz * axes.z.z;
    }
    // Centrifugal w^2 (x, y, 0) and Coriolis -2 w x v with w = (0, 0, w).
    const w = this.omega;
    ax += w * w * r.x + 2 * w * v.y;
    ay += w * w * r.y - 2 * w * v.x;
    return { x: ax, y: ay, z: az };
  }
}

function sub3(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function dot3(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
