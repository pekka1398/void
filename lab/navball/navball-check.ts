/** Headless checks of the navball's geometry (the drawing itself is checked by eye in the page). */
import { headingPitch, horizonAxes, horizonDirection, navballBasis, toBall, type NavballInput, type Vec3 } from './src/Navball';

let failed = false;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed = true;
}
function throws(run: () => void): string | null {
  try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return null;
}
const normalize = (a: Vec3): Vec3 => { const l = Math.hypot(a.x, a.y, a.z); return { x: a.x / l, y: a.y / l, z: a.z / l }; };
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const angleDifference = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

// ENU at the equator on the prime meridian (+x): east +y, north +z, up +x; the pole is +z.
const east: Vec3 = { x: 0, y: 1, z: 0 }, north: Vec3 = { x: 0, y: 0, z: 1 }, up: Vec3 = { x: 1, y: 0, z: 0 };
const zero: Vec3 = { x: 0, y: 0, z: 0 };
const primeMeridian: Vec3 = { x: 1, y: 0, z: 0 };
const standing: NavballInput = { nose: up, top: north, up, pole: north, primeMeridian, velocity: zero };

{
  const b = navballBasis(standing);
  const center = toBall(b, up), screenUp = toBall(b, north), screenRight = toBall(b, east);
  check('standing rocket, top to the north', distance(center, { x: 0, y: 0, z: 1 }) < 1e-12 && distance(screenUp, { x: 0, y: 1, z: 0 }) < 1e-12 &&
    distance(screenRight, { x: 1, y: 0, z: 0 }) < 1e-12,
    `zenith at the centre, north at the top, east at the right (ball ${JSON.stringify(center)}, ${JSON.stringify(screenUp)}, ${JSON.stringify(screenRight)})`);
  check('horizon axes', distance(b.north, north) < 1e-12 && distance(b.east, east) < 1e-12, 'north and east from the pole and the vertical');
}

{
  const b = navballBasis(standing);
  let worst = 0;
  for (let heading = 0; heading < 360; heading += 15) {
    for (let pitch = -85; pitch <= 85; pitch += 17) {
      const reading = headingPitch(b, horizonDirection(b, heading, pitch));
      worst = Math.max(worst, angleDifference(reading.heading, heading), Math.abs(reading.pitch - pitch));
    }
  }
  check('heading and pitch round trip', worst < 1e-9, `largest error ${worst.toExponential(1)} deg over headings 0-345, pitches -85-85`);
  const eastward = headingPitch(b, east), northEastUp = headingPitch(b, horizonDirection(b, 45, 30));
  check('compass', angleDifference(eastward.heading, 90) < 1e-9 && Math.abs(eastward.pitch) < 1e-9 && angleDifference(northEastUp.heading, 45) < 1e-9,
    `east reads ${eastward.heading.toFixed(3)}°, pitch ${eastward.pitch.toFixed(3)}°`);
}

{
  // Flying east, level, top up: prograde along the nose sits at the centre, retrograde behind the ball.
  const b = navballBasis({ nose: east, top: up, up, pole: north, primeMeridian, velocity: east });
  const prograde = toBall(b, east), retrograde = toBall(b, { x: 0, y: -1, z: 0 }), sky = toBall(b, up);
  check('level flight east', distance(prograde, { x: 0, y: 0, z: 1 }) < 1e-12 && retrograde.z < 0 && distance(sky, { x: 0, y: 1, z: 0 }) < 1e-12,
    'prograde at the centre, retrograde hidden, the sky above the centre');
  // A climb shows as a prograde marker above the reticle.
  const climbing = horizonDirection(b, 90, 10);
  const marker = toBall(b, climbing);
  check('climb marker', marker.y > 0 && Math.abs(marker.x) < 1e-12, `10° climb: marker at y ${marker.y.toFixed(4)} (sin 10° = ${Math.sin(Math.PI / 18).toFixed(4)})`);
}

{
  const meridian = throws(() => navballBasis({ ...standing, primeMeridian: normalize({ x: 1, y: 0, z: 0.1 }) }));
  check('prime meridian must lie on the equator', meridian !== null, meridian ?? 'did not throw');
  const skew = throws(() => navballBasis({ ...standing, top: { x: 0.1, y: 0, z: Math.sqrt(0.99) } }));
  check('nose and top must be perpendicular', skew !== null, skew ?? 'did not throw');
  const long = throws(() => navballBasis({ ...standing, up: { x: 2, y: 0, z: 0 } }));
  check('unit vectors', long !== null, long ?? 'did not throw');
}

{
  // Every horizon, from the equator to exactly at either pole, is a right-handed frame: east x north = up.
  let worst = 0;
  const offsets = [1, 0.1, 1e-6, 1e-11, 1e-13, 0];
  for (const sign of [1, -1]) {
    for (const offset of offsets) {
      const u = normalize({ x: offset, y: 0.3 * offset, z: sign });
      const { north: n, east: e } = horizonAxes(u, north, primeMeridian);
      const c = { x: e.y * n.z - e.z * n.y, y: e.z * n.x - e.x * n.z, z: e.x * n.y - e.y * n.x };
      worst = Math.max(worst, distance(c, u), Math.abs(Math.hypot(n.x, n.y, n.z) - 1), Math.abs(Math.hypot(e.x, e.y, e.z) - 1));
    }
  }
  check('horizon frames up to the poles', worst < 1e-9, `${offsets.length * 2} latitudes down to exactly ±90°: largest error ${worst.toExponential(1)}`);
  // Exactly at a pole the ball uses grid north, along the prime meridian, and reads headings from it.
  for (const [name, u] of [['north', north], ['south', { x: 0, y: 0, z: -1 }]] as const) {
    const b = navballBasis({ nose: primeMeridian, top: u, up: u, pole: north, primeMeridian, velocity: zero });
    const reading = headingPitch(b, primeMeridian);
    check(`grid north at the ${name} pole`, distance(b.north, primeMeridian) < 1e-15 && angleDifference(reading.heading, 0) < 1e-9 && Math.abs(reading.pitch) < 1e-9,
      `nose along the prime meridian reads HDG ${reading.heading.toFixed(3)}°, pitch ${reading.pitch.toFixed(3)}°`);
  }
}

console.log(failed ? '\nCHECKS FAILED' : '\nALL CHECKS PASSED');
if (failed) process.exit(1);
