import * as THREE from 'three/webgpu';
import { attribute, uniform, vec4 } from 'three/tsl';

export interface StarFieldOptions {
  readonly count: number;
  readonly seed: number;
  /** Share of the stars crowded toward the galactic plane, which draws the Milky Way's band. */
  readonly bandShare: number;
  /** Spread of the band stars about the plane, radians. */
  readonly bandWidth: number;
  /** Unit normal of the galactic plane, in the star field's own axes. */
  readonly galacticPole: { readonly x: number; readonly y: number; readonly z: number };
  /** Faintest magnitude drawn. */
  readonly faintest: number;
}

export const DEFAULT_STARS: StarFieldOptions = {
  count: 14_000, seed: 20260926, bandShare: 0.55, bandWidth: 0.14,
  galacticPole: { x: 0.28, y: -0.46, z: 0.84 }, faintest: 6.5,
};

/** A star field fixed in the sky: one-pixel points far beyond the scene, turned with the sky. */
export class StarField {
  readonly points: THREE.Points;
  /** Brightness of a magnitude-0 star; the main page sets it from how dark the sky is. */
  readonly brightness = uniform(0.08);

  constructor(options: StarFieldOptions = DEFAULT_STARS) {
    const { positions, colors } = generateStars(options);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsNodeMaterial({ sizeAttenuation: false, depthWrite: false });
    material.colorNode = vec4(attribute<'vec3'>('color', 'vec3').mul(this.brightness), 1);
    this.points = new THREE.Points(geometry, material);
    this.points.name = 'stars';
    this.points.frustumCulled = false;
    this.points.renderOrder = -1;
  }
}

/** Distance the stars are drawn at, metres: past any atmosphere and still well inside the far plane. */
export const STAR_DISTANCE = 1e12;

/**
 * Directions and colours (magnitude-0 star = 1). Magnitudes follow the
 * number of stars growing about 2.2× per magnitude; brightness falls
 * 10^(-0.25 m), flatter than the true 10^(-0.4 m), so a one-pixel faint star
 * stays visible on a display.
 */
export function generateStars(options: StarFieldOptions): { positions: Float32Array; colors: Float32Array } {
  const { count, bandShare, bandWidth, galacticPole, faintest } = options;
  if (!(count > 0) || !(bandShare >= 0 && bandShare <= 1) || !(bandWidth > 0)) throw new RangeError(`generateStars: ${JSON.stringify(options)}`);
  const poleLength = Math.hypot(galacticPole.x, galacticPole.y, galacticPole.z);
  if (Math.abs(poleLength - 1) > 1e-2) throw new RangeError(`generateStars: galacticPole length ${poleLength}`);
  const random = mulberry32(options.seed);
  const pole = new THREE.Vector3(galacticPole.x, galacticPole.y, galacticPole.z).normalize();
  const a = new THREE.Vector3().crossVectors(pole, Math.abs(pole.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  const b = new THREE.Vector3().crossVectors(pole, a);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const direction = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    if (random() < bandShare) {
      // Near the plane: a normally distributed galactic latitude.
      const longitude = random() * 2 * Math.PI;
      const latitude = gaussian(random) * bandWidth;
      direction.copy(a).multiplyScalar(Math.cos(latitude) * Math.cos(longitude))
        .addScaledVector(b, Math.cos(latitude) * Math.sin(longitude)).addScaledVector(pole, Math.sin(latitude));
    } else {
      const z = random() * 2 - 1;
      const phi = random() * 2 * Math.PI;
      const s = Math.sqrt(1 - z * z);
      direction.set(s * Math.cos(phi), s * Math.sin(phi), z);
    }
    direction.normalize().multiplyScalar(STAR_DISTANCE);
    positions[i * 3] = direction.x;
    positions[i * 3 + 1] = direction.y;
    positions[i * 3 + 2] = direction.z;
    // Inverse of N(<m) ∝ 10^(0.34 m), capped at the brightest real stars.
    const magnitude = Math.max(-1.5, faintest + Math.log10(Math.max(random(), 1e-12)) / 0.34);
    const brightness = 10 ** (-0.25 * magnitude);
    const [red, green, blue] = temperatureColor(3200 + random() ** 1.6 * 9000);
    colors[i * 3] = red * brightness;
    colors[i * 3 + 1] = green * brightness;
    colors[i * 3 + 2] = blue * brightness;
  }
  return { positions, colors };
}

/** Rough linear RGB of a star's colour, normalised so green is 1. */
function temperatureColor(kelvin: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (kelvin - 3200) / 9000));
  return [1.25 - 0.5 * t, 1, 0.55 + 0.75 * t];
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
