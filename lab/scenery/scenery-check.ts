/**
 * Headless checks for the scenery lab: the atmosphere's CPU side (transmittance
 * table, sky reference), a CPU port of the sky shader's ray march compared
 * with the reference, the star field and the surface camera.
 */
import {
  buildTransmittanceTable, densitiesAt, earthLikeAtmosphere, extinctionAt, miePhase, rayHitsGround, rayleighPhase, skyRadiance,
  transmittanceCoords, transmittanceRay, transmittanceToTop, TRANSMITTANCE_HEIGHT, TRANSMITTANCE_WIDTH, type AtmosphereParams, type Rgb, type Vec3,
} from './src/Atmosphere';
import { buildIrradianceTable, buildMultipleScatteringTable, irradianceLookup, marchSky, sphereDirections, transmittanceLookup } from './src/SkyTables';
import { generateStars, DEFAULT_STARS, STAR_DISTANCE } from './src/Stars';
import { OrbitView } from './src/OrbitView';
import { DEFAULT_LAYERED, layeredTerrain, MAX_HEIGHT, noise, noiseWithGradient, SEA_LEVEL } from './src/LayeredTerrain';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures += 1;
}
const fmt = (c: Rgb) => `(${c.map((v) => v.toExponential(3)).join(', ')})`;

const R = 6_371_000;
const p = earthLikeAtmosphere(R);

console.log('Transmittance');
{
  const zenith = transmittanceToTop(p, R, 1);
  const depth = (c: 0 | 1 | 2) => p.rayleighScattering[c] * p.rayleighScaleHeight * (1 - Math.exp(-100e3 / p.rayleighScaleHeight))
    + p.mieExtinction * p.mieScaleHeight + p.ozoneAbsorption[c] * p.ozoneWidth / 2;
  const flat: Rgb = [Math.exp(-depth(0)), Math.exp(-depth(1)), Math.exp(-depth(2))];
  const worst = Math.max(...zenith.map((v, c) => Math.abs(v / flat[c]! - 1)));
  check('zenith against the flat-atmosphere integral', worst < 2e-3, `${fmt(zenith)} vs ${fmt(flat)}, worst ${worst.toExponential(2)}`);

  let monotone = true;
  let previous: Rgb = [1, 1, 1];
  const horizonMu = -Math.sqrt(1 - (R / R) ** 2);
  for (let k = 0; k <= 200; k += 1) {
    const mu = 1 - (k / 200) * (1 - horizonMu - 1e-6);
    const t = transmittanceToTop(p, R, mu);
    if (t.some((v, c) => v > previous[c]! + 1e-12)) monotone = false;
    previous = t;
  }
  check('dims from zenith to horizon', monotone, `horizon ${fmt(previous)}`);
  check('sun on the horizon is red', previous[0] > previous[1] && previous[1] > previous[2], fmt(previous));

  let worstRoundTrip = 0;
  for (let k = 0; k < 2000; k += 1) {
    const r = R + ((k * 0.618034) % 1) * (p.topRadius - R);
    const horizon = -Math.sqrt(1 - (R / r) ** 2);
    const mu = horizon + ((k * 0.414214) % 1) * (1 - horizon);
    const { x, y } = transmittanceCoords(p, r, mu);
    const back = transmittanceRay(p, x, y);
    worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back.r - r) / R, Math.abs(back.mu - mu));
  }
  check('table coordinates round trip', worstRoundTrip < 1e-9, `worst ${worstRoundTrip.toExponential(2)}`);

  const table = buildTransmittanceTable(p);
  let worstLookup = 0;
  let where = '';
  for (let k = 0; k < 3000; k += 1) {
    const r = R + ((k * 0.754877) % 1) ** 2 * (p.topRadius - R);
    const horizon = -Math.sqrt(1 - (R / r) ** 2);
    const mu = horizon + 0.02 + ((k * 0.569840) % 1) * (1 - horizon - 0.02);
    const direct = transmittanceToTop(p, r, mu);
    const looked = lookup(table, p, r, mu);
    for (let c = 0; c < 3; c += 1) {
      const error = Math.abs(looked[c]! - direct[c]!);
      if (error > worstLookup) { worstLookup = error; where = `h=${(r - R).toFixed(0)} m mu=${mu.toFixed(4)}`; }
    }
  }
  check('table lookup (bilinear) against direct integration', worstLookup < 5e-3, `worst ${worstLookup.toExponential(2)} at ${where}`);
}

console.log('Sky');
{
  const up: Vec3 = { x: 0, y: 0, z: 1 };
  const noonSun = normalize({ x: 0.3, y: 0, z: 1 });
  const zenith = skyRadiance(p, 2, up, noonSun);
  check('noon zenith is blue', zenith[2] > zenith[1] && zenith[1] > zenith[0], fmt(zenith));
  const sunsetSun = normalize({ x: 1, y: 0, z: Math.tan(0.5 * Math.PI / 180) });
  const towardSun = skyRadiance(p, 2, normalize({ x: 1, y: 0, z: 0.03 }), sunsetSun);
  check('sunset sky toward the sun is red', towardSun[0] > towardSun[2], fmt(towardSun));
  const space = skyRadiance(p, 99e3, up, noonSun);
  check('from the top of the air, straight up is dark', Math.max(...space) < 1e-3 * Math.max(...zenith), `${fmt(space)} vs ${fmt(zenith)}`);

  // The shader's march (32 quadratic steps, table transmittance) against the 2000-step reference.
  const table = buildTransmittanceTable(p);
  const cases: [string, number, Vec3, Vec3][] = [
    ['noon zenith', 2, up, noonSun],
    ['noon horizon', 2, normalize({ x: 0, y: 1, z: 0.02 }), noonSun],
    ['sunset toward the sun', 2, normalize({ x: 1, y: 0, z: 0.03 }), sunsetSun],
    ['sunset away from the sun', 2, normalize({ x: -1, y: 0, z: 0.1 }), sunsetSun],
    ['10 km looking down', 10e3, normalize({ x: 0.3, y: 0, z: -1 }), noonSun],
    ['99 km, toward the limb', 99e3, normalize({ x: 1, y: 0, z: -0.25 }), noonSun],
  ];
  for (const [name, altitude, direction, sun] of cases) {
    const reference = skyRadiance(p, altitude, direction, sun);
    const marched = marchLikeShader(p, table, altitude, direction, sun, 32);
    const error = Math.max(...reference.map((v, c) => Math.abs(marched[c]! - v) / Math.max(...reference)));
    check(`shader march: ${name}`, error < 0.05, `${fmt(marched)} vs ${fmt(reference)}, ${(error * 100).toFixed(2)}% of the brightest channel`);
  }
}

console.log('Multiple scattering and sky irradiance');
{
  const transmittance = buildTransmittanceTable(p);
  const started = performance.now();
  const multiple = buildMultipleScatteringTable(p, transmittance);
  const irradiance = buildIrradianceTable(p, transmittance, multiple);
  const built = performance.now() - started;
  check('tables are finite and non-negative', [...multiple, ...irradiance].every((v) => Number.isFinite(v) && v >= 0), `built in ${built.toFixed(0)} ms`);
  const r = R + 2;
  const noonSun = normalize({ x: 0.3, y: 0, z: 1 });
  const up = { x: 0, y: 0, z: 1 };
  const single = marchSky(p, transmittance, null, r, up, noonSun, 32).radiance;
  const multiplied = marchSky(p, transmittance, multiple, r, up, noonSun, 32).radiance;
  const gain = multiplied[2] / single[2] - 1;
  check('multiple scattering brightens the noon sky moderately', gain > 0.1 && gain < 0.8, `blue +${(gain * 100).toFixed(0)}% (${fmt(single)} → ${fmt(multiplied)})`);
  const twilightSun = normalize({ x: 1, y: 0, z: -0.07 });
  const twilightSingle = marchSky(p, transmittance, null, r, up, twilightSun, 32).radiance;
  const twilightMultiple = marchSky(p, transmittance, multiple, r, up, twilightSun, 32).radiance;
  check('and matters more in twilight (sun 4° down)', twilightMultiple[2] / twilightSingle[2] > 1 + gain, `blue ×${(twilightMultiple[2] / twilightSingle[2]).toFixed(2)}`);

  const noon = irradianceLookup(irradiance, p, r, noonSun.z);
  const direct = transmittanceLookup(transmittance, p, r, noonSun.z).map((t) => t * noonSun.z);
  const share = (noon[1] / (noon[1] + direct[1]!));
  check('sky light is about a tenth of daylight at noon', share > 0.05 && share < 0.25, `green: sky ${noon[1].toFixed(4)} of ${(noon[1] + direct[1]!).toFixed(4)} (${(share * 100).toFixed(0)}%)`);
  let falling = true, previous = Infinity;
  for (let mu = 1; mu >= -0.3; mu -= 0.05) {
    const e = irradianceLookup(irradiance, p, r, mu)[1];
    if (e > previous + 1e-9) falling = false;
    previous = e;
  }
  check('sky light fades as the sun sets and is gone at night', falling && previous < 1e-4, `at sun 17° down: ${previous.toExponential(2)}`);
  // The table's 64 hemisphere directions against 512.
  const sum = [0, 0, 0];
  const fine = sphereDirections(1024).filter((d) => d.z > 0);
  for (const d of fine) {
    const radiance = marchSky(p, transmittance, multiple, r, d, noonSun, 24).radiance;
    for (let c = 0; c < 3; c += 1) sum[c]! += radiance[c]! * d.z * (2 * Math.PI) / fine.length;
  }
  const worst = Math.max(...[0, 1, 2].map((c) => Math.abs(noon[c]! / sum[c]! - 1)));
  check('irradiance table converged in directions', worst < 0.05, `${fmt(noon)} vs ${fmt(sum as unknown as Rgb)} with ${fine.length} directions`);
}

console.log('Stars');
{
  const { positions, colors } = generateStars(DEFAULT_STARS);
  let worst = 0, inBand = 0;
  const pole = normalize(DEFAULT_STARS.galacticPole);
  for (let i = 0; i < DEFAULT_STARS.count; i += 1) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    const length = Math.hypot(x, y, z);
    worst = Math.max(worst, Math.abs(length / STAR_DISTANCE - 1));
    if (Math.abs((x * pole.x + y * pole.y + z * pole.z) / length) < Math.sin(15 * Math.PI / 180)) inBand += 1;
  }
  check('stars on the sky sphere', worst < 1e-6, `worst radius error ${worst.toExponential(2)}`);
  const uniform = Math.sin(15 * Math.PI / 180);
  check('Milky Way band is crowded', inBand / DEFAULT_STARS.count > 2 * uniform, `${(100 * inBand / DEFAULT_STARS.count).toFixed(0)}% within 15° of the plane (uniform: ${(100 * uniform).toFixed(0)}%)`);
  check('colours finite and positive', colors.every((v) => Number.isFinite(v) && v > 0), `${colors.length / 3} stars`);
}

console.log('Orbit view');
{
  const view = new OrbitView({ x: 0.3, y: 0.2, z: 0.9 }, R + 2e6, 0.4, 200e6);
  let worst = 0;
  for (let k = 0; k < 500; k += 1) {
    view.orbitAroundCenter(((k * 0.618) % 1) - 0.5, ((k * 0.414) % 1) - 0.5);
    view.turn(((k * 0.732) % 1) - 0.5, ((k * 0.236) % 1) * 0.6 - 0.3);
    view.panScreen(((k * 0.5) % 7) - 3, ((k * 0.3) % 5) - 2, Math.PI / 3, 1000, 1e4);
    const { right, up, back } = view.basis();
    const c = cross(right, up);
    worst = Math.max(worst, Math.abs(dot(right, right) - 1), Math.abs(dot(up, up) - 1), Math.abs(dot(right, up)),
      Math.abs(c.x - back.x), Math.abs(c.y - back.y), Math.abs(c.z - back.z));
  }
  check('basis stays orthonormal and right-handed', worst < 1e-9, `worst ${worst.toExponential(2)} after 500 mixed drags`);
  const { position } = view.pose();
  const direction = normalize(position);
  view.setRadius(R + 2);
  const after = view.pose().position;
  const moved = normalize(after);
  check('zoom keeps the point under the camera', Math.abs(Math.hypot(after.x, after.y, after.z) - (R + 2)) < 1e-6 && Math.abs(dot(direction, moved) - 1) < 1e-15,
    `radius ${(Math.hypot(after.x, after.y, after.z) - R).toFixed(9)} m above R`);
  view.place({ x: 0, y: 0, z: 1 }, R + 2, 0, Math.PI / 2);
  const onPole = view.basis();
  check('placed on the pole, level', Math.abs(onPole.back.z) < 1e-12 && Math.abs(onPole.up.z - 1) < 1e-12, JSON.stringify(onPole.back));
  view.place({ x: 1, y: 0, z: 0 }, R + 2, 0, Math.PI - 0.01);
  check('tilt reaches almost straight up', -view.basis().back.x > 0.9999, `forward.x ${(-view.basis().back.x).toFixed(6)}`);
  view.place({ x: 1, y: 0, z: 0 }, R + 2, 0, Math.PI / 2);
  check('heading 0 looks north', Math.abs(-view.basis().back.z - 1) < 1e-12, JSON.stringify(view.basis().back));
}

console.log('Layered terrain');
{
  const sample = layeredTerrain(DEFAULT_LAYERED);
  const g = { x: 0, y: 0, z: 0 };
  let worstGradient = 0;
  for (let k = 0; k < 1000; k += 1) {
    const x = ((k * 0.618) % 1) * 50 - 25, y = ((k * 0.414) % 1) * 50 - 25, z = ((k * 0.732) % 1) * 50 - 25;
    noiseWithGradient(x, y, z, g);
    const e = 1e-6;
    const numeric = [(noise(x + e, y, z) - noise(x - e, y, z)) / (2 * e), (noise(x, y + e, z) - noise(x, y - e, z)) / (2 * e), (noise(x, y, z + e) - noise(x, y, z - e)) / (2 * e)];
    worstGradient = Math.max(worstGradient, Math.abs(numeric[0]! - g.x), Math.abs(numeric[1]! - g.y), Math.abs(numeric[2]! - g.z));
  }
  check('noise gradient is the analytic derivative', worstGradient < 1e-6, `worst ${worstGradient.toExponential(2)} against central differences`);

  let s = 11;
  const random = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const direction = (): Vec3 => { const z = random() * 2 - 1, phi = random() * 2 * Math.PI, r = Math.sqrt(1 - z * z); return { x: r * Math.cos(phi), y: r * Math.sin(phi), z }; };
  const quantile = (values: number[], q: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(q * (sorted.length - 1))]!; };
  const heights: number[] = [];
  const slopes: Record<'plains' | 'mountains', Record<number, number[]>> = { plains: { 10: [], 100: [], 1000: [] }, mountains: { 10: [], 100: [], 1000: [] } };
  let worstBand = 0;
  for (let k = 0; k < 6000; k += 1) {
    const d = direction();
    const h = sample(d, 1).heightMeters;
    heights.push(h);
    // A 1 km-cell tile keeps the shape: dropping sub-2 km octaves moves the ground by much less than its relief.
    worstBand = Math.max(worstBand, Math.abs(sample(d, 1000).heightMeters - h));
    const elevation = h - SEA_LEVEL;
    const kind = elevation > 2500 ? 'mountains' : elevation > 0 && elevation < 600 ? 'plains' : null;
    if (!kind) continue;
    const east = { x: -d.y, y: d.x, z: 0 };
    const eastLength = Math.hypot(east.x, east.y);
    for (const spacing of [10, 100, 1000]) {
      const a = spacing / R;
      const moved = normalize({ x: d.x + (east.x / eastLength) * a, y: d.y + (east.y / eastLength) * a, z: d.z });
      slopes[kind][spacing]!.push(Math.atan(Math.abs(sample(moved, 1).heightMeters - h) / spacing) * 180 / Math.PI);
    }
  }
  const land = heights.filter((h) => h > SEA_LEVEL).length / heights.length;
  check('about a third is land', land > 0.25 && land < 0.45, `${(land * 100).toFixed(0)}%`);
  const highest = Math.max(...heights) - SEA_LEVEL, deepest = SEA_LEVEL - Math.min(...heights);
  check('peaks and basins at Earth-like heights', highest > 6000 && highest < 10_000 && deepest > 3000 && deepest < SEA_LEVEL,
    `highest ${highest.toFixed(0)} m, deepest ${deepest.toFixed(0)} m, within 0–${MAX_HEIGHT} m`);
  check('band limit at 1 km cells stays small', worstBand < 400, `worst change ${worstBand.toFixed(0)} m`);
  const line = (kind: 'plains' | 'mountains') => [10, 100, 1000].map((sp) => `${sp} m: p50 ${quantile(slopes[kind][sp]!, 0.5).toFixed(1)}° p99 ${quantile(slopes[kind][sp]!, 0.99).toFixed(0)}°`).join(' · ');
  check('plains are gentle at every scale', [10, 100, 1000].every((sp) => quantile(slopes.plains[sp]!, 0.99) < 10), line('plains'));
  check('mountains are steep but not cliffs', [10, 100, 1000].every((sp) => quantile(slopes.mountains[sp]!, 0.5) > 3 && quantile(slopes.mountains[sp]!, 0.99) < 45), line('mountains'));
  // Scale consistency: slopes change smoothly with the scale, with no scale where the ground turns rough or smooth abruptly.
  const ratio = quantile(slopes.mountains[10]!, 0.5) / quantile(slopes.mountains[1000]!, 0.5);
  check('mountain slopes vary smoothly with scale', ratio > 1 && ratio < 4, `median slope at 10 m is ${ratio.toFixed(2)}× that at 1 km`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
if (failures > 0) process.exit(1);

/** Bilinear table lookup at (r, mu), as the GPU's linear filter does. */
function lookup(table: Float32Array, p: AtmosphereParams, r: number, mu: number): Rgb {
  const { x, y } = transmittanceCoords(p, r, mu);
  const fx = x * (TRANSMITTANCE_WIDTH - 1), fy = y * (TRANSMITTANCE_HEIGHT - 1);
  const i = Math.min(TRANSMITTANCE_WIDTH - 2, Math.floor(fx)), j = Math.min(TRANSMITTANCE_HEIGHT - 2, Math.floor(fy));
  const u = fx - i, v = fy - j;
  const at = (a: number, b: number, c: number) => table[(b * TRANSMITTANCE_WIDTH + a) * 4 + c]!;
  const channel = (c: number) => (1 - v) * ((1 - u) * at(i, j, c) + u * at(i + 1, j, c)) + v * ((1 - u) * at(i, j + 1, c) + u * at(i + 1, j + 1, c));
  return [channel(0), channel(1), channel(2)];
}

/** AtmosphereNodes.composite's march on the CPU: quadratic step spacing, table transmittance, Hillaire's step integral. */
function marchLikeShader(p: AtmosphereParams, table: Float32Array, altitude: number, direction: Vec3, sun: Vec3, steps: number): Rgb {
  const r0 = p.bottomRadius + altitude;
  const mu0 = direction.z;
  const length = rayHitsGround(p, r0, mu0)
    ? -r0 * mu0 - Math.sqrt(r0 * r0 * (mu0 * mu0 - 1) + p.bottomRadius ** 2)
    : -r0 * mu0 + Math.sqrt(r0 * r0 * (mu0 * mu0 - 1) + p.topRadius ** 2);
  const cosTheta = dot(direction, sun);
  const phaseR = rayleighPhase(cosTheta), phaseM = miePhase(p.mieAnisotropy, cosTheta);
  const transmittance = [1, 1, 1], inscatter = [0, 0, 0];
  for (let i = 0; i < steps; i += 1) {
    const s0 = i / steps, s1 = (i + 1) / steps, sm = (i + 0.5) / steps;
    const t = length * sm * sm, dt = length * (s1 * s1 - s0 * s0);
    const r = Math.sqrt(r0 * r0 + 2 * r0 * mu0 * t + t * t);
    const height = Math.max(0, r - p.bottomRadius);
    const d = densitiesAt(p, height);
    const e = extinctionAt(p, height);
    const sunMu = (r0 * sun.z + t * cosTheta) / r;
    const horizon = -Math.sqrt(Math.max(0, 1 - (p.bottomRadius / r) ** 2));
    const toSun = sunMu < horizon ? [0, 0, 0] : lookup(table, p, Math.min(r, p.topRadius), sunMu);
    for (let c = 0; c < 3; c += 1) {
      const scattering = p.rayleighScattering[c as 0 | 1 | 2] * d.rayleigh * phaseR + p.mieScattering * d.mie * phaseM;
      const source = scattering * toSun[c]!;
      const step = Math.exp(-e[c]! * dt);
      inscatter[c]! += transmittance[c]! * (source - source * step) / e[c]!;
      transmittance[c]! *= step;
    }
  }
  return [inscatter[0]!, inscatter[1]!, inscatter[2]!];
}

function normalize(v: Vec3): Vec3 { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; }
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a: Vec3, b: Vec3): Vec3 { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
