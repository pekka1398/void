import type { Vec3 } from '../lod/Vec3';
import { LANDING_TEST_PLANET } from './PlanetPresets';

/**
 * Scripted probe and camera paths shared by the headless select benchmark
 * (lod-bench.ts) and the in-browser benchmark (?bench=). They assume the
 * landing preset's geometry. Frames are steps, not seconds; the browser runs
 * one step per rendered frame.
 */
export interface BenchFrame {
  /** Body-fixed meters. */
  readonly probe: Vec3;
  readonly camera: Vec3;
  /** The camera looks at this body-fixed point. */
  readonly target: Vec3;
}

export interface BenchScenario {
  readonly name: string;
  readonly frames: number;
  readonly at: (frame: number) => BenchFrame;
}

const p = LANDING_TEST_PLANET;
const top = p.radiusMeters + p.maxSurfaceHeightMeters;

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a.x, a.y, a.z));
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
/** A direction `angle` radians from `from` along the great circle toward `toward`. */
const along = (from: Vec3, toward: Vec3, angle: number): Vec3 => {
  const f = unit(from);
  const side = unit(cross(cross(f, toward), f));
  return add(scale(f, Math.cos(angle)), scale(side, Math.sin(angle)));
};
/** Camera 3 km behind (along -east) and 1 km above a body-fixed point. */
const chase = (point: Vec3): Vec3 => {
  const up = unit(point);
  const east = unit(cross({ x: 0, y: 1, z: 0 }, up));
  return add(add(point, scale(east, -3000)), scale(up, 1000));
};

const pad = unit({ x: 0.62, y: 0.35, z: 0.7 });
const east = unit(cross({ x: 0, y: 1, z: 0 }, pad));
const north = cross(pad, east);
const probe = scale(pad, top);
const origin = { x: 0, y: 0, z: 0 };

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
  { name: 'static chase', frames: 300, at: () => ({ probe, camera: chase(probe), target: probe }) },
  { name: 'orbit chase', frames: 600, at: (frame) => {
    // One circle of 5 km radius around the probe, 1 km above it.
    const angle = frame / 600 * 2 * Math.PI;
    return { probe, target: probe,
      camera: add(add(probe, scale(pad, 1000)), add(scale(east, 5000 * Math.cos(angle)), scale(north, 5000 * Math.sin(angle)))) };
  } },
  { name: 'ascent', frames: 3000, at: (frame) => {
    // Pad to 200 km while travelling 0.03 rad (about 190 km) downrange, camera chasing.
    const s = frame / 3000;
    const craft = scale(along(pad, east, 0.03 * s), top + 200_000 * s * s);
    return { probe: craft, camera: chase(craft), target: craft };
  } },
  { name: 'camera swing', frames: 300, at: (frame) => {
    // Camera at 2 R swings half way around the planet in 120 frames, then holds; the probe stays on the pad.
    const s = Math.min(1, frame / 120);
    return { probe, camera: scale(along(pad, east, Math.PI * s), 2 * p.radiusMeters), target: origin };
  } },
  { name: 'low traverse', frames: 1000, at: (frame) => {
    // Camera 500 m over the terrain top, 60 m per frame (3.6 km/s at 60 fps), a quarter of the way round
    // from the probe, looking 5 km ahead along its track.
    const start = along(pad, east, Math.PI / 2);
    const here = along(start, north, frame * 60 / top);
    const ahead = along(start, north, (frame * 60 + 5000) / top);
    return { probe, camera: scale(here, top + 500), target: scale(ahead, top) };
  } },
];
