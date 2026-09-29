import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { bodyOrientation, cross, DominanceTree, dot, FlightPlan, length, normalize, PropagationRun, spinAxis, STANDARD_GRAVITY, sub, type Vec3 } from '../../src/orbitCore';
import { demoRocket, planetEphemeris, predictCoast, PartJointRocket, type LanderControl } from '../../src/landingCore';
import { OrbitCamera, viewState } from '../view/src/ViewCamera';
import { bodyFixedToRender, quatMultiply, quatRotate, renderAxes, vesselAxes } from '../../src/FlightFrame';
import { navballBasis, toBall } from '../../src/navballCore';
import { gamePlanetById } from '../../src/GamePlanet';
import { FlightScenery } from '../../src/FlightScenery';
import * as GPU_THREE from 'three/webgpu';
import { layeredTerrain } from '../scenery/src/LayeredTerrain';
import { terrainFromConfig } from '../landing/src/terrain/TerrainConfig';
import { buildTerrainTile } from '../landing/src/terrain/TerrainTiles';
import { tileContaining } from '../lod/src/lod/TileSearch';
import { checkTerrainContract } from '../landing/src/terrain/SurfaceContract';

let failures = 0;
const normalizeQuat = (q: { x: number; y: number; z: number; w: number }) => {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
};
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`);
  if (!ok) failures += 1;
}
// atan2 of |a x b| and a . b stays accurate for tiny angles, where acos of the dot product does not.
const angle = (a: Vec3, b: Vec3) => Math.atan2(length(cross(a, b)), dot(a, b));

await RAPIER.init();
const gamePlanet = gamePlanetById('aurelia');
const planet = gamePlanet.planet;
const { ephemeris, bodyIndex } = planetEphemeris(planet);
const home = ephemeris.bodies[bodyIndex]!;
const rocket = demoRocket(planet.terrain);
if (gamePlanet.launchSite) rocket.launchSite = gamePlanet.launchSite;
const launch = () => PartJointRocket.landed(RAPIER, ephemeris, bodyIndex, planet.terrain, rocket.full, rocket.upper, rocket.booster, rocket.options, rocket.launchSite);

{
  // Body-fixed to render rotation equals three.js's own basis-to-quaternion, at several times of day.
  let worst = 0;
  for (const t of [0, 1234.5, 40_000, 86_164]) {
    const axes = bodyOrientation(home, t);
    const mine = bodyFixedToRender(axes);
    const r = (v: Vec3) => new THREE.Vector3(v.x, v.z, -v.y);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r(axes.x), r(axes.y), r(axes.z)));
    const sign = Math.sign(q.w * mine.w + q.x * mine.x + q.y * mine.y + q.z * mine.z);
    worst = Math.max(worst, Math.abs(q.x - sign * mine.x), Math.abs(q.y - sign * mine.y), Math.abs(q.z - sign * mine.z), Math.abs(q.w - sign * mine.w));
    for (const [local, world] of [[{ x: 1, y: 0, z: 0 }, axes.x], [{ x: 0, y: 1, z: 0 }, axes.y], [{ x: 0, y: 0, z: 1 }, axes.z]] as const) {
      worst = Math.max(worst, angle(quatRotate(mine, local), renderAxes(world)));
    }
  }
  check('body-fixed axes turn into render axes', worst < 1e-12, `largest difference from three.js ${worst.toExponential(1)}`);
}

{
  // The rocket's rendered attitude (render-from-body-fixed times its body-fixed attitude) is its attitude in space:
  // upright at the launch site, and after settling on the slope, its axis is the body-fixed axis carried by the planet's axes.
  const lander = launch();
  const idle: LanderControl = { throttle: 0, up: 1, prograde: 0, turn: { x: 0, y: 0, z: 0 } };
  const rendered = () => quatRotate(quatMultiply(bodyFixedToRender(bodyOrientation(home, lander.time)), lander.partOrientation('upper')), { x: 0, y: 1, z: 0 });
  const vertical = () => renderAxes(sub(lander.frame.toInertial(lander.time, lander.partState('upper')).position, ephemeris.bodyPosition(bodyIndex, lander.time)));
  const atStart = angle(rendered(), vertical());
  lander.advance(30, idle);
  check('layered launch stays on dry ground with both parts intact',
    planet.terrain.sample(normalize(rocket.launchSite)).heightMeters > gamePlanet.seaLevel &&
    lander.partMode('upper') !== 'destroyed' && lander.partMode('booster') !== 'destroyed',
    `sea ${gamePlanet.seaLevel} m; upper ${lander.partMode('upper')}, booster ${lander.partMode('booster')}`);
  const axes = bodyOrientation(home, lander.time);
  const u = quatRotate(lander.partOrientation('upper'), { x: 0, y: 1, z: 0 });
  const expected = renderAxes({ x: u.x * axes.x.x + u.y * axes.y.x + u.z * axes.z.x, y: u.x * axes.x.y + u.y * axes.y.y + u.z * axes.z.y, z: u.x * axes.x.z + u.y * axes.y.z + u.z * axes.z.z });
  const settled = angle(rendered(), expected);
  // Rapier keeps attitudes as float32 quaternions (about 1e-7 relative), so agreement is to float32, not float64.
  check('rocket attitude drawn in space', atStart < 1e-6 && settled < 1e-6,
    `upright at launch to ${atStart.toExponential(1)} rad; after 30 s standing on the slope (tilted ${(angle(rendered(), vertical()) * 180 / Math.PI).toFixed(2)} deg from vertical) the drawn axis matches to ${settled.toExponential(1)} rad`);
  lander.free();
}

{
  // Co-rotating by spinAxis x rotation rate x dt keeps the camera fixed to the ground (Aurelia has a 23.4 deg tilt).
  const axesAt = (t: number) => bodyOrientation(home, t);
  const camera = new OrbitCamera(normalize({ x: 0.3, y: -0.8, z: 0.5 }), 45);
  const local = (t: number) => { const a = axesAt(t); return { x: dot(camera.direction, a.x), y: dot(camera.direction, a.y), z: dot(camera.direction, a.z) }; };
  const start = local(0);
  const omega = (2 * Math.PI) / home.rotation.periodSeconds;
  let t = 0, worst = 0;
  for (let i = 0; i < 360; i += 1) {
    camera.corotate(spinAxis(home), omega * 60);
    t += 60;
    const now = local(t);
    worst = Math.max(worst, Math.hypot(now.x - start.x, now.y - start.y, now.z - start.z));
  }
  check('co-rotating camera stays fixed to the ground', worst < 1e-9, `6 h in 1 min steps: drift ${worst.toExponential(1)} (unit vector)`);
  const landed = viewState('single', false, { kind: 'vessel', radial: { x: 1, y: 0, z: 0 }, north: spinAxis(home), referenceRadius: home.radiusMeters, altitude: 0, focusRadius: 0 }, 45);
  check('landed close-up is the flight view, co-rotating', landed.mapWeight === 0 && landed.corotation === 1, `map ${landed.mapWeight}, co-rotation ${landed.corotation}`);
}

{
  // After a burn, the coast forecast's inertial trajectory (the map path) is the same coast as its body-fixed points.
  const lander = launch();
  lander.advance(2, { throttle: 0, up: 1, prograde: 0, turn: { x: 0, y: 0, z: 0 } });
  // Full burn with the booster (liftoff thrust-to-weight about 2 on Aurelia), then the coast.
  lander.advance(60, { throttle: 1, up: 1, prograde: 0, turn: { x: 0, y: 0, z: 0 } });
  const prediction = predictCoast(ephemeris, lander.frame, planet.terrain, rocket.options.tolerances, lander.time, lander.bodyFixedState(), lander.massKg, 6000);
  const trajectory = prediction.trajectory;
  let worst = 0, compared = 0;
  for (const point of prediction.points) {
    if (point.time > trajectory.lastTime) continue;
    const inertial = trajectory.sample(point.time);
    const fixed = lander.frame.toBodyFixed(point.time, inertial).position;
    if (prediction.impact && point.time === prediction.impact.time) continue;
    worst = Math.max(worst, length(sub(fixed, point.position)));
    compared += 1;
  }
  const dominant = new DominanceTree(ephemeris.bodies);
  const positions = new Float64Array(ephemeris.bodyCount * 3);
  ephemeris.positionsAt(lander.time, positions);
  const reference = dominant.dominant(positions, lander.frame.toInertial(lander.time, lander.bodyFixedState()).position);
  const pastImpact = prediction.impact ? trajectory.lastTime - prediction.impact.time : 0;
  check('map path matches the body-fixed forecast', compared >= 5 && worst < 1e-3 && reference === bodyIndex && pastImpact >= 0 && pastImpact <= 15,
    `${compared} points, largest difference ${worst.toExponential(1)} m; ${trajectory.count} inertial samples to T+${trajectory.lastTime.toFixed(0)} s; impact ${prediction.impact ? `at T+${prediction.impact.time.toFixed(1)} s, path ends ${pastImpact.toFixed(2)} s after it` : 'none'}; reference ${ephemeris.bodies[reference]!.name}`);
  lander.free();
}

{
  // The navball's screen axes agree with the steering keys: S (torque about local +x) moves the nose
  // up the ball, D (about local +z) to the right, whatever the attitude.
  const attitude = normalizeQuat({ x: 0.3, y: -0.5, z: 0.2, w: 0.8 });
  const { nose, top } = vesselAxes(attitude);
  const basis = navballBasis({ nose, top, up: normalize({ x: 0.2, y: 0.9, z: 0.4 }), pole: { x: 0, y: 0, z: 1 }, primeMeridian: { x: 1, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
  const a = 0.01;
  const turned = (axis: Vec3) => toBall(basis, vesselAxes(quatMultiply(attitude, { x: axis.x * Math.sin(a / 2), y: axis.y * Math.sin(a / 2), z: axis.z * Math.sin(a / 2), w: Math.cos(a / 2) })).nose);
  const s = turned({ x: 1, y: 0, z: 0 }), d = turned({ x: 0, y: 0, z: 1 });
  check('navball follows the steering keys', s.y > 0.9 * a && Math.abs(s.x) < 1e-9 && d.x > 0.9 * a && Math.abs(d.y) < 1e-9,
    `a 0.01 rad turn: S moves the nose to ball (${s.x.toExponential(1)}, ${s.y.toExponential(2)}), D to (${d.x.toExponential(2)}, ${d.y.toExponential(1)})`);
}

{
  const config = planet.terrainConfig;
  if (config.kind !== 'layered') throw new Error('default game terrain must be layered');
  const cloned = terrainFromConfig(structuredClone(config));
  const original = layeredTerrain(config.options);
  const contract = checkTerrainContract(cloned, 256);
  check('scenery terrain satisfies the landing contract', contract.length === 0, JSON.stringify(contract));
  let worst = 0;
  for (const cell of [1, 10, 100, 1000]) {
    for (const d of [normalize(rocket.launchSite), { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }]) {
      worst = Math.max(worst, Math.abs(cloned.sample(d, cell).heightMeters - original(d, cell).heightMeters));
    }
  }
  const key = tileContaining(normalize(rocket.launchSite), rocket.options.contact.tileLevel);
  const collision = buildTerrainTile(key, planet.terrain, rocket.options.contact.tileResolution);
  const worker = buildTerrainTile(key, cloned, rocket.options.contact.tileResolution);
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((n, i) => n === b[i]);
  check('worker and collision terrain share the band-limited scenery sampler', worst === 0 &&
    same(collision.positions, worker.positions) && same(collision.heights, worker.heights),
    `sample difference ${worst} m; ${collision.heights.length} matching tile heights`);
  check('airless lab planets remain airless', !gamePlanetById('luna').atmosphere && gamePlanetById('luna').terrainId === 'hills', 'Luna uses hills with no air or ocean');
}

{
  // No graphics context is needed to verify the frame uniforms consumed by the shared shaders.
  const renderer = new GPU_THREE.WebGPURenderer({ forceWebGL: true,
    canvas: { width: 16, height: 16, style: {}, addEventListener() {} } as unknown as HTMLCanvasElement });
  const scenery = new FlightScenery(renderer, new GPU_THREE.Scene(), gamePlanet);
  const camera = new GPU_THREE.PerspectiveCamera(58, 1, 0.1, 1e14);
  let worst = 0;
  for (const time of [0, 20_000, 86_164]) {
    const axes = bodyOrientation(home, time);
    const q = bodyFixedToRender(axes);
    const rotation = new GPU_THREE.Quaternion(q.x, q.y, q.z, q.w);
    const renderToBody = new GPU_THREE.Matrix4().makeRotationFromQuaternion(rotation.clone().invert());
    const origin = new GPU_THREE.Vector3(4e6, 3e6, 4e6);
    for (const offset of [new GPU_THREE.Vector3(20, -10, 35), new GPU_THREE.Vector3(0, 0, 800e3)]) {
      const bodyCamera = origin.clone().add(offset);
      camera.position.copy(offset).applyQuaternion(rotation);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      const sun = new GPU_THREE.Vector3(1, 0.2, -0.1).normalize();
      scenery.update({ cameraBodyFixed: bodyCamera, renderOriginBodyFixed: origin, sunBodyFixed: sun,
        renderToBody, camera, focalPixels: 1000, time });
      const sample = new GPU_THREE.Vector3(30, 12, -5);
      const renderSample = sample.clone().applyQuaternion(rotation);
      const shaderRelative = renderSample.sub(scenery.ground.renderCameraPosition.value).applyMatrix4(scenery.ground.renderToBody.value);
      const shaderBody = shaderRelative.sub(scenery.atmosphere.planetCenter.value);
      worst = Math.max(worst, shaderBody.distanceTo(origin.clone().add(sample)));
      const ray = new GPU_THREE.Vector3(0.2, -0.3, -1).normalize();
      const actualRay = ray.clone().transformDirection(scenery.atmosphere.cameraRotation.value);
      const expectedRay = ray.clone().transformDirection(camera.matrixWorld).applyQuaternion(rotation.clone().invert());
      worst = Math.max(worst, actualRay.distanceTo(expectedRay), scenery.ground.localOrigin.value.distanceTo(origin));
    }
  }
  check('scenery rays and terrain stay body-fixed across focus offsets and planet rotation', worst < 1e-7,
    `largest frame difference ${worst.toExponential(1)}; independent near-ground and orbital camera offsets`);
}

{
  // The upper stage consumes the same fuel and follows the same finite Frenet burn as orbit's FlightPlan.
  const lander = launch();
  const idle: LanderControl = { throttle: 0, up: 1, prograde: 0 };
  lander.advance(2, idle);
  lander.advance(60, { ...idle, throttle: 1 });
  lander.separate();
  const live = lander.frame.toInertial(lander.time, lander.partState('upper'));
  const plan = new FlightPlan(ephemeris, rocket.options.tolerances, {
    thrustNewtons: rocket.upper.thrustNewtons, exhaustVelocity: rocket.upper.specificImpulseSeconds * STANDARD_GRAVITY,
    dryMassKg: rocket.upper.dryMassKg,
  }, 60);
  plan.rebase(new PropagationRun({ time: lander.time, ...live, massKg: lander.massKg }));
  plan.add({ startTime: lander.time + 2, referenceBody: bodyIndex, referenceMode: 'fixed', prograde: 5, normal: 0, radial: 0 });
  plan.extend(100_000);
  const burn = plan.burns[0]!;
  lander.advance(2, idle);
  lander.advance(burn.endTime - burn.startTime, { ...idle, throttle: 1,
    orbitalAttitude: { kind: 'frenet', referenceBody: bodyIndex, tangent: 1, normal: 0, radial: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 } });
  const actual = lander.frame.toInertial(lander.time, lander.partState('upper'));
  const expected = plan.trajectory.sample(lander.time);
  const positionError = length(sub(actual.position, expected.position));
  const fuelError = Math.abs(lander.massKg - burn.massAfterKg);
  check('upper-stage maneuver follows orbit flight plan', positionError < 0.1 && fuelError < 1e-6,
    `position ${positionError.toExponential(2)} m, mass ${fuelError.toExponential(2)} kg`);
  lander.free();
}

if (failures > 0) {
  console.log(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
