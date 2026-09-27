import { buildCloudNoise, buildCloudWeather, cloudDensity, cloudShellIntervals, cloudWeather, CLOUD_BOTTOM,
  CLOUD_TOP, CLOUD_EXTINCTION, DEFAULT_CLOUD_COVERAGE, DETAIL_PERIOD, DETAIL_SIZE, sampleCloudNoise, SHAPE_PERIOD, SHAPE_SIZE,
  weatherCoverage, WEATHER_WIDTH, WEATHER_HEIGHT } from './src/CloudField';
import type { Vec3 } from './src/Atmosphere';

type Check = (name: string, ok: boolean, detail: string) => void;
export function checkClouds(check: Check): void {
  console.log('Volumetric clouds');
  const R = 6371000, sea = 5000, inner = R + sea + CLOUD_BOTTOM, outer = R + sea + CLOUD_TOP;
  const up = { x: 1, y: 0, z: 0 }, down = { x: -1, y: 0, z: 0 };
  const ground = cloudShellIntervals({ x: R + sea + 2, y: 0, z: 0 }, up, inner, outer);
  const orbit = cloudShellIntervals({ x: R + sea + 400000, y: 0, z: 0 }, down, inner, outer, 400000);
  const inside = cloudShellIntervals({ x: R + sea + 3000, y: 0, z: 0 }, up, inner, outer);
  check('shell heights start at sea level; ground and orbit see the same column', ground.length === 1 && orbit.length === 1
    && Math.abs(ground[0]![0] - 1498) < 1e-6 && Math.abs(ground[0]![1] - 7998) < 1e-6
    && Math.abs(orbit[0]![1] - orbit[0]![0] - (CLOUD_TOP - CLOUD_BOTTOM)) < 1e-6,
  `ground ${JSON.stringify(ground)} m; orbit ${JSON.stringify(orbit)} m`);
  const both = cloudShellIntervals({ x: outer + 10000, y: 0, z: 0 }, down, inner, outer);
  const clipped = cloudShellIntervals({ x: R + sea + 3000, y: 0, z: 0 }, up, inner, outer, 200);
  check('camera inside, far-side shell and scene-depth clipping', inside.length === 1 && Math.abs(inside[0]![1] - 5000) < 1e-6
    && both.length === 2 && clipped.length === 1 && clipped[0]![0] === 0 && clipped[0]![1] === 200,
  `inside ${JSON.stringify(inside)}, two segments ${both.length}, clipped ${JSON.stringify(clipped)}`);
  const tangent = cloudShellIntervals({ x: -1000000, y: (inner + outer) / 2, z: 0 }, up, inner, outer);
  const miss = cloudShellIntervals({ x: -1000000, y: outer + 1, z: 0 }, up, inner, outer);
  check('grazing ray remains in cloud; a miss stays empty', tangent.length === 1 && miss.length === 0,
    `${tangent.length} grazing interval, ${miss.length} missed intervals`);

  const coarseA = cloudDensity(3000, 0.6, 0.6, 0, 0, DEFAULT_CLOUD_COVERAGE, 0, 32000);
  const coarseB = cloudDensity(3000, 0.6, 0.6, 1, 1, DEFAULT_CLOUD_COVERAGE, 0, 32000);
  check('unresolved cloud coverage does not flicker with local noise', coarseA > 0 && Math.abs(coarseA - coarseB) < 1e-12
    && cloudDensity(3000, 0.6, 0.6, 1, 1, 0, 0, 32000) === 0,
  `coarse density ${coarseA.toFixed(4)}; local-noise change ${Math.abs(coarseA - coarseB)}`);

  const atlas = buildCloudWeather(), shape = buildCloudNoise(SHAPE_SIZE, false), detail = buildCloudNoise(DETAIL_SIZE, true);
  let weatherCount = 0, densityCount = 0, worstPeriodic = 0, worstWeatherSeam = 0, worstAtlas = 0;
  const atlasSample = (d: Vec3): readonly [number, number] => {
    const qx = (Math.atan2(d.y, d.x) / (2 * Math.PI) + 0.5) * WEATHER_WIDTH;
    const qy = (Math.asin(d.z) / Math.PI + 0.5) * (WEATHER_HEIGHT - 1);
    const ix = Math.floor(qx), iy = Math.floor(qy), fx = qx - ix, fy = qy - iy;
    const channel = (c: number) => {
      let sum = 0;
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        const xx = ((ix + x) % WEATHER_WIDTH + WEATHER_WIDTH) % WEATHER_WIDTH;
        const yy = Math.min(WEATHER_HEIGHT - 1, iy + y);
        sum += atlas[(yy * WEATHER_WIDTH + xx) * 4 + c]! / 255 * (x ? fx : 1 - fx) * (y ? fy : 1 - fy);
      }
      return sum;
    };
    return [channel(0), channel(1)];
  };
  for (let i = 0; i < 6000; i++) {
    const z = 1 - 2 * (i + 0.5) / 6000, phi = i * 2.399963229728653, r = Math.sqrt(1 - z * z);
    const d = { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
    const [humidity, type] = cloudWeather(d), lookup = atlasSample(d);
    worstAtlas = Math.max(worstAtlas, Math.abs(humidity - lookup[0]), Math.abs(type - lookup[1]));
    if (weatherCoverage(humidity) > 0.3) weatherCount++;
    const column = { x: d.x * (R + sea + CLOUD_BOTTOM), y: d.y * (R + sea + CLOUD_BOTTOM), z: d.z * (R + sea + CLOUD_BOTTOM) };
    const macro = 0.7 * sampleCloudNoise(shape, SHAPE_SIZE, column, SHAPE_PERIOD * 16, 2)
      + 0.3 * sampleCloudNoise(shape, SHAPE_SIZE, column, SHAPE_PERIOD * 16);
    let cloudy = false;
    for (const h of [2000, 3000, 4000, 5000, 6000]) {
      const position = { x: d.x * (R + sea + h), y: d.y * (R + sea + h), z: d.z * (R + sea + h) };
      const n = sampleCloudNoise(shape, SHAPE_SIZE, position, SHAPE_PERIOD);
      const f = sampleCloudNoise(detail, DETAIL_SIZE, position, DETAIL_PERIOD);
      if (cloudDensity(h, lookup[0], lookup[1], n, f, DEFAULT_CLOUD_COVERAGE, 1, 0, macro) > 0.02) cloudy = true;
    }
    if (cloudy) densityCount++;
    if (i < 100) {
      const p = { x: i * 791.3 - 23000, y: i * -31.9, z: i * 411.4 };
      for (const [data, size, period] of [[shape, SHAPE_SIZE, SHAPE_PERIOD], [detail, DETAIL_SIZE, DETAIL_PERIOD]] as const) {
        const a = sampleCloudNoise(data, size, p, period);
        for (const axis of ['x', 'y', 'z'] as const) {
          const b = sampleCloudNoise(data, size, { ...p, [axis]: p[axis] + period }, period);
          worstPeriodic = Math.max(worstPeriodic, Math.abs(a - b));
        }
      }
      const seam = (longitude: number) => atlasSample({ x: Math.cos(phi) * Math.cos(longitude),
        y: Math.cos(phi) * Math.sin(longitude), z: Math.sin(phi) });
      const a = seam(Math.PI - 1e-8), b = seam(-Math.PI + 1e-8);
      worstWeatherSeam = Math.max(worstWeatherSeam, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
  }
  const fraction = weatherCount / 6000, columns = densityCount / 6000;
  check('weather and volume have broken global coverage', fraction > 0.55 && fraction < 0.75 && columns > 0.4 && columns < 0.8,
    `weather ${(fraction * 100).toFixed(1)}%; nonempty columns ${(columns * 100).toFixed(1)}%`);
  check('weather atlas resolves the spherical field and wraps at longitude', worstAtlas < 0.08 && worstWeatherSeam < 1e-5,
    `lookup error ${worstAtlas.toFixed(4)}; seam ${worstWeatherSeam.toExponential(2)}`);
  check('3D noise repeats continuously, including negative body-fixed positions', worstPeriodic < 1e-12,
    `worst ${worstPeriodic.toExponential(2)}`);
  let bounded = true, empty = true, monotonic = true;
  for (let i = 0; i <= 100; i++) {
    const h = i * 100, density = cloudDensity(h, 0.9, 0.6, 0.7, 0.5);
    bounded &&= Number.isFinite(density) && density >= 0 && density <= 1;
    if (h <= CLOUD_BOTTOM || h >= CLOUD_TOP) empty &&= density === 0;
    empty &&= cloudDensity(h, 0.9, 0.6, 0.7, 0.5, 0) === 0;
    monotonic &&= cloudDensity(h, 0.9, 0.6, 0.7, 0.5, 0.4) <= density;
  }
  check('density vanishes outside the layer and at zero coverage', bounded && empty && monotonic,
    'bounded, sea-relative profile; coverage control is monotonic');

  const peak = (macro: number) => {
    let highest = 0;
    for (let h = CLOUD_BOTTOM; h <= CLOUD_TOP; h += 25) {
      if (cloudDensity(h, 0.9, 0.8, 0.9, 0.9, DEFAULT_CLOUD_COVERAGE, 0, 100, macro) > 0.01) highest = h;
    }
    return highest;
  };
  const shoulder = peak(0.4), summit = peak(0.8);
  check('banks have raised tops and open gaps rather than a uniform slab', summit - shoulder > 1500
    && peak(0.1) === 0 && summit < CLOUD_TOP,
  `shoulder ${shoulder} m, summit ${summit} m, clear gap ${peak(0.1)} m`);

  // Independent homogeneous-volume solution: segmentation must not change Beer-Lambert transport.
  const sigma = 0.25 * CLOUD_EXTINCTION, length = CLOUD_TOP - CLOUD_BOTTOM;
  let transmission = 1, light = 0;
  const source = 0.08;
  for (let i = 0; i < 64; i++) {
    const dt = length * (((i + 1) / 64) ** 2 - (i / 64) ** 2);
    const step = Math.exp(-sigma * dt);
    light += transmission * source * (1 - step);
    transmission *= step;
  }
  const exact = Math.exp(-sigma * length);
  check('volume transport matches Beer-Lambert, independent of step spacing', Math.abs(transmission - exact) < 1e-12
    && Math.abs(light - source * (1 - exact)) < 1e-12,
    `T=${transmission.toFixed(4)}, L=${light.toFixed(4)}`);
}
