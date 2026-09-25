import { cross, dot, length, normalize, osculatingOrbit, type Vec3 } from '../orbit/src/orbit';
import { buildTileMesh, PlanetLod, tileContaining, tileId, type LodSelection, type LodView } from '../lod/src/lod';
import { landingLodOptions, levelForTileSize, terrainFromConfig, type ContactWorldOptions } from './src/planetCore';
import { ellipsePoints } from './src/ConicPath';
import {
  FLIGHT_MAX_DISTANCE, MAP_MIN_DISTANCE, MIN_ANGLE_FROM_UP, OrbitCamera, rotate, viewState, type FocusGeometry,
} from './src/ViewCamera';

let failures = 0;
function check(ok: boolean, message: string): void {
  if (!ok) { failures += 1; console.error(`FAIL ${message}`); }
}
function angle(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (length(a) * length(b)))));
}
const DEG = Math.PI / 180;
const R = 6.371e6;
const north = normalize({ x: 0, y: 0.4, z: 0.92 });
// A vessel 60 degrees from the pole: flight "up" and map "up" differ a lot.
const radial = normalize(rotate(north, normalize(cross(north, { x: 1, y: 0, z: 0 })), 60 * DEG));
const vesselAt = (altitude: number): FocusGeometry => ({ kind: 'vessel', radial, north, referenceRadius: R, altitude, focusRadius: 0 });

{
  // Single view: zooming out from the vessel to interplanetary distance changes nothing abruptly.
  const camera = new OrbitCamera(normalize({ x: 1, y: -0.3, z: 0.2 }), 5);
  let previous = viewState('single', false, vesselAt(0), camera.distance);
  check(previous.mapWeight === 0 && previous.corotation === 1, `landed close-up should be flight view co-rotating; ${JSON.stringify(previous)}`);
  check(angle(previous.up, radial) < 1e-12, 'landed close-up up should be the local vertical');
  let worstUpStep = 0, worstDirectionStep = 0;
  camera.clampToUp(previous.up);
  while (camera.distance < 1e11) {
    const before = camera.direction;
    camera.zoom(1.01, previous.minDistance, previous.maxDistance);
    const next = viewState('single', false, vesselAt(0), camera.distance);
    camera.clampToUp(next.up);
    worstUpStep = Math.max(worstUpStep, angle(previous.up, next.up));
    worstDirectionStep = Math.max(worstDirectionStep, angle(before, camera.direction));
    check(next.mapWeight >= previous.mapWeight, `map weight fell while zooming out at ${camera.distance}`);
    check(next.corotation <= previous.corotation, `co-rotation rose while zooming out at ${camera.distance}`);
    previous = next;
  }
  check(previous.mapWeight === 1 && previous.corotation === 0, `far out should be the map, inertial; ${JSON.stringify(previous)}`);
  check(angle(previous.up, north) < 1e-12, 'far out up should be north');
  check(worstUpStep < 0.5 * DEG, `up turned ${(worstUpStep / DEG).toFixed(3)} deg in one 1% zoom step`);
  check(worstDirectionStep < 0.5 * DEG, `view direction turned ${(worstDirectionStep / DEG).toFixed(3)} deg in one 1% zoom step`);
  console.log(`single view zoom 5 m -> 1e11 m: largest step up ${(worstUpStep / DEG).toFixed(3)} deg, direction ${(worstDirectionStep / DEG).toFixed(3)} deg`);
}

{
  // An orbiting vessel's close-up is inertial (KSP's orbital camera); a landed one's follows the ground.
  const orbiting = viewState('single', false, vesselAt(100e3), 30);
  check(orbiting.mapWeight === 0 && orbiting.corotation === 0, `vessel at 100 km close-up: ${JSON.stringify(orbiting)}`);
  const low = viewState('single', false, vesselAt(10e3), 30);
  check(low.corotation === 1, `vessel at 10 km should co-rotate: ${low.corotation}`);
}

{
  // Co-rotating fully for one spin period returns the camera to where it started.
  const camera = new OrbitCamera(normalize({ x: 0.2, y: -1, z: 0.5 }), 30);
  const start = camera.direction;
  for (let i = 0; i < 1000; i += 1) camera.corotate(north, (2 * Math.PI) / 1000);
  check(angle(start, camera.direction) < 1e-9, `one full co-rotation moved the camera ${angle(start, camera.direction)} rad`);
}

{
  // Dragging never passes over the pole and azimuth drags keep the elevation.
  const camera = new OrbitCamera(normalize({ x: 1, y: 0, z: 0.1 }), 30);
  const up = { x: 0, y: 0, z: 1 };
  const elevation = angle(camera.direction, up);
  camera.drag(300, 0, up);
  check(Math.abs(angle(camera.direction, up) - elevation) < 1e-12, 'azimuth drag changed the elevation');
  camera.drag(0, 5000, up);
  check(Math.abs(angle(camera.direction, up) - MIN_ANGLE_FROM_UP) < 1e-9, `drag past the top should stop ${MIN_ANGLE_FROM_UP} rad from up, got ${angle(camera.direction, up)}`);
  camera.drag(0, -10000, up);
  check(Math.abs(angle(camera.direction, up) - (Math.PI - MIN_ANGLE_FROM_UP)) < 1e-9, 'drag past the bottom should stop above straight down');
  camera.drag(0, 5000, up);
  camera.clampToUp({ x: 0, y: 0, z: -1 });
  check(angle(camera.direction, { x: 0, y: 0, z: -1 }) >= MIN_ANGLE_FROM_UP - 1e-12, 'clamp against a flipped up');
}

{
  // Split view: flight and map each keep their own zoom range; the flight view only looks at the vessel.
  const flight = viewState('split', false, vesselAt(100e3), 1e9);
  check(flight.maxDistance === FLIGHT_MAX_DISTANCE && flight.mapWeight === 0, `split flight: ${JSON.stringify(flight)}`);
  const map = viewState('split', true, vesselAt(100e3), 10);
  check(map.minDistance === MAP_MIN_DISTANCE && map.mapWeight === 1 && map.corotation === 0, `split map: ${JSON.stringify(map)}`);
  let threw = false;
  try { viewState('split', false, { kind: 'body', radial: null, north, referenceRadius: R, altitude: 0, focusRadius: R }, 4 * R); } catch { threw = true; }
  check(threw, 'split flight view focused on a body should throw');
  const bodyMap = viewState('split', true, { kind: 'body', radial: null, north, referenceRadius: R, altitude: 0, focusRadius: R }, 4 * R);
  check(bodyMap.minDistance === Math.max(1.02 * R, R + MAP_MIN_DISTANCE), `split map on a body: min ${bodyMap.minDistance}`);
}

{
  // Osculating ellipses: points lie between periapsis and apoapsis, and the body's position is on the loop.
  const gm = 3.986e14;
  const r = { x: 7e6, y: 1e5, z: 2e5 }, v = { x: -200, y: 7.9e3, z: 1.5e3 };
  const osc = osculatingOrbit(r, v, gm);
  const n = 256;
  const points = ellipsePoints(r, v, gm, n);
  let nearest = Infinity;
  for (let i = 0; i < n; i += 1) {
    const p = { x: points[i * 3]!, y: points[i * 3 + 1]!, z: points[i * 3 + 2]! };
    const d = length(p);
    check(d >= osc.periapsisRadiusMeters * (1 - 1e-12) && d <= osc.apoapsisRadiusMeters * (1 + 1e-12), `ellipse point ${i} at ${d}`);
    check(Math.abs(dot(p, cross(r, v))) < 1e-3 * d * length(cross(r, v)), `ellipse point ${i} off the orbit plane`);
    nearest = Math.min(nearest, length({ x: p.x - r.x, y: p.y - r.y, z: p.z - r.z }));
  }
  const chord = (2 * Math.PI * osc.apoapsisRadiusMeters) / n;
  check(nearest < chord, `current position ${nearest.toFixed(0)} m from the loop (chord ${chord.toFixed(0)} m)`);
  const circle = ellipsePoints({ x: 7e6, y: 0, z: 0 }, { x: 0, y: Math.sqrt(gm / 7e6), z: 0 }, gm, 64);
  check(Math.abs(circle[0]! - 7e6) < 1e-3 && Math.abs(circle[1]!) < 1e-3, 'a circle starts at the current position');
  let threw = false;
  try { ellipsePoints(r, { x: 0, y: 12e3, z: 0 }, gm, 64); } catch { threw = true; }
  check(threw, 'an escape trajectory has no ellipse and should throw');
}

{
  // The camera as a second lab/lod observer: from far out, the planet's face toward the camera is drawn,
  // though it is below the vessel's horizon; without the camera it is culled.
  const radius = 100e3;
  const terrain = terrainFromConfig({ kind: 'hills', options: { name: 'check hills', radiusMeters: radius, maxHeightMeters: 3000, wavelengthMeters: 8000, octaves: 6 } });
  const contact: ContactWorldOptions = { stepSeconds: 1 / 60, tileLevel: levelForTileSize(radius, 300), tileResolution: 17,
    tileReachMeters: 300, tileKeepMeters: 600, recenterMeters: 1000 };
  const options = landingLodOptions(terrain, contact);
  const vessel = { x: radius + 100e3, y: 0, z: 0 };
  const cameraFar = { x: -10 * radius, y: 0.3 * radius, z: 0 };
  const settle = (lod: PlanetLod, view: LodView): LodSelection => {
    for (let i = 0; i < 400; i += 1) {
      const selection = lod.select(view);
      if (selection.requests.length === 0) return selection;
      for (const request of selection.requests.slice(0, 64)) lod.acceptTile(buildTileMesh(request.key, terrain.sample, { radiusMeters: radius, resolution: contact.tileResolution }));
    }
    throw new Error('LOD did not settle in 400 rounds');
  };
  const farSide = normalize(cameraFar);
  const drawnOver = (selection: LodSelection, direction: Vec3): number => {
    const ids = new Set(selection.render.map((node) => node.id));
    for (let level = options.maxLevel; level >= 0; level -= 1) if (ids.has(tileId(tileContaining(direction, level)))) return level;
    return -1;
  };
  const vesselOnly = settle(new PlanetLod(options), { observerPositions: [vessel], distanceScale: 1, horizonCulling: true });
  const withCamera = settle(new PlanetLod(options), { observerPositions: [vessel, cameraFar], distanceScale: 1, horizonCulling: true });
  check(drawnOver(vesselOnly, farSide) === -1, 'far side should be culled with only the vessel observing');
  check(drawnOver(withCamera, farSide) >= 0, 'far side facing the camera should be drawn with the camera observing');
  check(drawnOver(withCamera, normalize(vessel)) === drawnOver(vesselOnly, normalize(vessel)), 'the camera observer changed detail under the vessel');
  console.log(`camera observer: tiles ${vesselOnly.render.length} (vessel only) -> ${withCamera.render.length}; under vessel L${drawnOver(withCamera, normalize(vessel))}, far side L${drawnOver(withCamera, farSide)}`);
}

if (failures > 0) {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
