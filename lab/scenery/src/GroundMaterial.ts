import * as THREE from 'three/webgpu';
import {
  attribute, clamp, vertexColor, cos, dot, float, floor, Fn, fract, fwidth, max, mix, mod, normalize, normalWorld, positionLocal, positionWorld, pow,
  sin, smoothstep, uniform, vec3,
} from 'three/tsl';
import type { AtmosphereShading } from './AtmosphereNodes';

/**
 * Deep-water waves: integer multiples of 2π / WAVE_PERIOD on each body-fixed
 * axis, so the pattern repeats every WAVE_PERIOD metres along x, y and z and
 * the camera's position can be passed modulo that period without a seam.
 * Each is [nx, ny, nz, slope]: slope is amplitude times wavenumber.
 */
export const WAVE_PERIOD = 4096;
const WAVES: readonly (readonly [number, number, number, number])[] = [
  [37, 91, 13, 0.06],
  [-83, 22, 57, 0.05],
  [150, -40, 110, 0.035],
  [-20, 170, -190, 0.025],
];
const GRAVITY = 9.81;
/** Wavelengths of the ground's sub-mesh detail, metres; each divides WAVE_PERIOD, so the pattern has no seam. */
const DETAIL_WAVELENGTHS = [256, 64, 16, 4, 1];

type Vec3Node = THREE.Node<'vec3'>;
type FloatNode = THREE.Node<'float'>;

/** Value noise in 0–1 on an integer lattice that repeats every `period` cells. */
function periodicValueNoise(p: Vec3Node, period: number): FloatNode {
  const cell = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const corner = (dx: number, dy: number, dz: number): FloatNode => {
    const c = mod(cell.add(vec3(dx, dy, dz)), period);
    return fract(sin(dot(c, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
  };
  const x00 = mix(corner(0, 0, 0), corner(1, 0, 0), u.x), x10 = mix(corner(0, 1, 0), corner(1, 1, 0), u.x);
  const x01 = mix(corner(0, 0, 1), corner(1, 0, 1), u.x), x11 = mix(corner(0, 1, 1), corner(1, 1, 1), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/**
 * The lit ground and sea for lab/lod's tiles. Unlit by three: sunlight is
 * computed here, through the atmosphere's transmittance, so the ground
 * reddens at sunset and goes dark past the terminator; the composite pass then
 * adds the air between the ground and the camera.
 *
 * Land colour comes from height and slope (sand by the water, grass, rock on
 * steep ground and above the terrain's rock height, snow on flat ground above its snow height). The tile vertex colour
 * is not used. Vertices below sea level are raised onto the sea surface; the
 * sea is coloured by its depth, reflects a flat sky colour, and carries a sun
 * glint shaped by the waves.
 */
export class GroundMaterial {
  readonly material = new THREE.MeshBasicNodeMaterial();
  /** Sea level above the reference radius, metres. */
  readonly seaLevel = uniform(1800);
  readonly oceanEnabled = uniform(1);
  /** Camera body-fixed position modulo WAVE_PERIOD on each axis, metres. */
  readonly waveOrigin = uniform(new THREE.Vector3());
  readonly time = uniform(0);

  /** Heights where rock and snow begin, metres. */
  constructor(atmosphere: AtmosphereShading, rockHeight: number, snowHeight: number) {
    const height = attribute<'float'>('height', 'float');
    const center = atmosphere.planetCenter;
    const sea = this.seaLevel;
    const ocean = this.oceanEnabled;

    // lab/lod's batch has already placed the vertex camera-relative, so it is in render space here.
    this.material.positionNode = Fn(() => {
      const up = normalize(positionLocal.sub(center));
      return positionLocal.add(up.mul(max(sea.sub(height), 0).mul(ocean)));
    })();

    this.material.colorNode = Fn(() => {
      const fromCenter = positionWorld.sub(center);
      const up = normalize(fromCenter);
      const r = fromCenter.length();
      const sun = atmosphere.sunDirection;
      const sunMu = dot(up, sun);
      const sunlight = atmosphere.sunTransmittance(r, sunMu).mul(atmosphere.sunIlluminance);
      // Placeholder sky light until a sky irradiance table: bluish, fading through twilight, plus starlight.
      const skyLight = vec3(0.1, 0.14, 0.22).mul(smoothstep(-0.2, 0.3, sunMu)).mul(atmosphere.sunIlluminance).add(2e-4);

      // Land.
      const normal = normalize(normalWorld);
      const flat = dot(normal, up);
      const aboveSea = height.sub(sea.mul(ocean));
      const sand = vec3(0.42, 0.37, 0.26);
      const rock = vec3(0.16, 0.145, 0.13);
      const snow = vec3(0.62, 0.64, 0.68);
      // What covers the land (desert to forest) comes with the tile, from the terrain's sampler.
      const vegetation = vertexColor();
      const lowland = mix(sand, vegetation, smoothstep(2, 12, aboveSea).max(ocean.oneMinus()));
      // Bare rock on steep ground, and on gentler slopes the higher it is (soil and plants thin out with height).
      const high = smoothstep(sea, float(rockHeight), height);
      const steep = float(1).sub(smoothstep(mix(float(0.75), float(0.94), high), mix(float(0.9), float(0.985), high), flat));
      const rocky = mix(lowland, rock, max(steep, smoothstep(rockHeight, rockHeight + 800, height)));
      // The snow line falls toward the poles, to 30% of its height above the sea there.
      const snowLine = float(snowHeight).sub(float(snowHeight).sub(sea).mul(0.7).mul(up.z.mul(up.z)));
      const albedo = mix(rocky, snow, smoothstep(snowLine, snowLine.add(300), height).mul(smoothstep(0.8, 0.9, flat)));
      // Detail finer than the mesh: mottling from 256 m down to 1 m, each octave faded out where it is under a pixel.
      const detailPosition = positionWorld.add(this.waveOrigin);
      const detail = float(0).toVar();
      for (const [index, wavelength] of DETAIL_WAVELENGTHS.entries()) {
        const q = detailPosition.div(wavelength).add(index * 17.31);
        const width = fwidth(q);
        const visible = float(1).sub(smoothstep(0.3, 1, max(width.x, max(width.y, width.z))));
        detail.addAssign(periodicValueNoise(q, WAVE_PERIOD / wavelength).sub(0.5).mul(visible).mul(0.35 * 0.8 ** index));
      }
      const mottled = albedo.mul(detail.add(1));
      const land = mottled.mul(sunlight.mul(max(dot(normal, sun), 0)).add(skyLight)).div(Math.PI);

      // Sea: wave normals from the waves' slopes, faded out where a wave is under a pixel wide.
      const wavePosition = positionWorld.add(this.waveOrigin);
      const slope = vec3(0, 0, 0).toVar();
      const drawn = float(0).toVar();
      for (const [nx, ny, nz, steepness] of WAVES) {
        const k = vec3(nx, ny, nz).mul((2 * Math.PI) / WAVE_PERIOD);
        const omega = Math.sqrt(GRAVITY * ((2 * Math.PI) / WAVE_PERIOD) * Math.hypot(nx, ny, nz));
        const phase = dot(k, wavePosition).sub(this.time.mul(omega));
        const resolved = float(1).sub(smoothstep(0.4, 1.5, fwidth(phase)));
        const along = normalize(k.sub(up.mul(dot(k, up))));
        slope.addAssign(along.mul(cos(phase).mul(steepness).mul(resolved)));
        drawn.addAssign(resolved.div(WAVES.length));
      }
      const waterNormal = normalize(up.sub(slope));
      const toCamera = normalize(positionWorld.negate());
      const facing = clamp(dot(waterNormal, toCamera), 0, 1);
      const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));
      const depth = max(sea.sub(height), 0);
      const deep = vec3(0.004, 0.018, 0.035);
      const water = mix(deep, albedo.mul(0.5), pow(float(0.5), depth.div(6)));
      const body = water.mul(sunlight.mul(max(sunMu, 0)).add(skyLight)).div(Math.PI);
      const skyReflection = skyLight.mul(vec3(0.6, 0.8, 1.2)).div(Math.PI);
      const halfway = normalize(sun.add(toCamera));
      // Waves too small to draw still roughen the sea: their slopes spread the glint as a broad,
      // dim lobe (Cox–Munk-like, slope variance about 0.03), the way the glitter looks from orbit.
      const shininess = mix(float(60), float(600), drawn);
      const glint = pow(max(dot(waterNormal, halfway), 0), shininess).mul(shininess.add(8).div(8 * Math.PI))
        .mul(fresnel).mul(sunlight).mul(max(dot(waterNormal, sun), 0));
      const seaColor = mix(body, skyReflection, fresnel).add(glint);

      // Coast: where the interpolated height crosses sea level, about a pixel wide.
      const wet = float(1).sub(smoothstep(fwidth(height).negate(), fwidth(height), height.sub(sea))).mul(ocean);
      return mix(land, seaColor, wet);
    })();
  }

  update(cameraBodyFixed: { x: number; y: number; z: number }, seconds: number): void {
    const wrap = (v: number) => v - Math.floor(v / WAVE_PERIOD) * WAVE_PERIOD;
    this.waveOrigin.value.set(wrap(cameraBodyFixed.x), wrap(cameraBodyFixed.y), wrap(cameraBodyFixed.z));
    // Every wave's period divides no common time; keep the clock small for float32 by wrapping at a day.
    this.time.value = seconds % 86_400;
  }
}
