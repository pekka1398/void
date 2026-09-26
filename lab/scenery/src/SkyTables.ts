import {
  densitiesAt, extinctionAt, miePhase, rayHitsGround, rayleighPhase, transmittanceCoords,
  TRANSMITTANCE_HEIGHT, TRANSMITTANCE_WIDTH, type AtmosphereParams, type Rgb, type Vec3,
} from './Atmosphere';

/**
 * The tables built on the CPU from the transmittance table, after Hillaire
 * 2020: multiple scattering, and the sky's irradiance on the ground. Both
 * are per unit sun illuminance and take (height, sun zenith cosine).
 *
 * Layout of both: x = (mu_s + 1) / 2, y = sqrt(height / air depth), texel
 * centres at 0 and 1 (the square root packs rows toward the ground, where
 * both change fastest). RGBA, alpha 1.
 */
export const MULTIPLE_SCATTERING_SIZE = 32;
export const IRRADIANCE_WIDTH = 32;
export const IRRADIANCE_HEIGHT = 16;
/** Ground albedo the multiple-scattering bounce assumes. */
export const GROUND_ALBEDO = 0.3;

/** Bilinear lookup of the transmittance table, as the GPU filters it. */
export function transmittanceLookup(table: Float32Array, p: AtmosphereParams, r: number, mu: number): Rgb {
  const { x, y } = transmittanceCoords(p, Math.min(r, p.topRadius), mu);
  return bilinear(table, TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT, x, y);
}

/** Sunlight reaching radius r with the sun at zenith cosine mu: zero below the ground's horizon (hard edge on the CPU). */
export function sunlightAt(table: Float32Array, p: AtmosphereParams, r: number, mu: number): Rgb {
  return rayHitsGround(p, r, mu) ? [0, 0, 0] : transmittanceLookup(table, p, r, mu);
}

export function tableCoords(p: AtmosphereParams, r: number, sunMu: number): { x: number; y: number } {
  const height = Math.min(Math.max(r - p.bottomRadius, 0), p.topRadius - p.bottomRadius);
  return { x: (Math.max(-1, Math.min(1, sunMu)) + 1) / 2, y: Math.sqrt(height / (p.topRadius - p.bottomRadius)) };
}

export function multipleScatteringLookup(table: Float32Array, p: AtmosphereParams, r: number, sunMu: number): Rgb {
  const { x, y } = tableCoords(p, r, sunMu);
  return bilinear(table, MULTIPLE_SCATTERING_SIZE, MULTIPLE_SCATTERING_SIZE, x, y);
}

export function irradianceLookup(table: Float32Array, p: AtmosphereParams, r: number, sunMu: number): Rgb {
  const { x, y } = tableCoords(p, r, sunMu);
  return bilinear(table, IRRADIANCE_WIDTH, IRRADIANCE_HEIGHT, x, y);
}

/** Directions spread evenly over the sphere (a Fibonacci lattice). */
export function sphereDirections(count: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const s = Math.sqrt(1 - z * z);
    out.push({ x: s * Math.cos(golden * i), y: s * Math.sin(golden * i), z });
  }
  return out;
}

/**
 * Hillaire's multiple-scattering table Ψ: light scattered twice or more, as
 * an isotropic source per unit scattering coefficient. For each height and sun
 * angle: the second-order light L2 arriving from every direction (single
 * scattering with an isotropic phase, plus the ground's bounce), and the
 * share f of light the air around re-scatters; the geometric series of all
 * orders is L2 / (1 − f).
 */
export function buildMultipleScatteringTable(p: AtmosphereParams, transmittance: Float32Array, directionCount = 64, steps = 20): Float32Array {
  const n = MULTIPLE_SCATTERING_SIZE;
  const data = new Float32Array(n * n * 4);
  const directions = sphereDirections(directionCount);
  const isotropic = 1 / (4 * Math.PI);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const sunMu = (i / (n - 1)) * 2 - 1;
      const height = (j / (n - 1)) ** 2 * (p.topRadius - p.bottomRadius);
      const r0 = p.bottomRadius + Math.min(height, p.topRadius - p.bottomRadius - 1);
      const sun = { x: Math.sqrt(Math.max(0, 1 - sunMu * sunMu)), y: 0, z: sunMu };
      const second = [0, 0, 0];
      const transfer = [0, 0, 0];
      for (const direction of directions) {
        const { length, hitsGround } = rayLength(p, r0, direction.z);
        const dt = length / steps;
        const t3 = [1, 1, 1];
        for (let s = 0; s < steps; s += 1) {
          const t = (s + 0.5) * dt;
          const px = direction.x * t, py = direction.y * t, pz = r0 + direction.z * t;
          const r = Math.hypot(px, py, pz);
          const h = r - p.bottomRadius;
          const d = densitiesAt(p, h);
          const e = extinctionAt(p, h);
          const sunlight = sunlightAt(transmittance, p, r, (px * sun.x + py * sun.y + pz * sun.z) / r);
          for (let c = 0; c < 3; c += 1) {
            const scattering = p.rayleighScattering[c as 0 | 1 | 2] * d.rayleigh + p.mieScattering * d.mie;
            const step = Math.exp(-e[c]! * dt);
            const absorbed = (1 - step) / e[c]!;
            second[c]! += (t3[c]! * scattering * sunlight[c]! * isotropic * absorbed) / directions.length;
            transfer[c]! += (t3[c]! * scattering * absorbed) / directions.length;
            t3[c]! *= step;
          }
        }
        if (hitsGround) {
          const px = direction.x * length, py = direction.y * length, pz = r0 + direction.z * length;
          const r = Math.hypot(px, py, pz);
          const groundSunMu = (px * sun.x + py * sun.y + pz * sun.z) / r;
          const sunlight = sunlightAt(transmittance, p, p.bottomRadius, groundSunMu);
          for (let c = 0; c < 3; c += 1) {
            second[c]! += (t3[c]! * sunlight[c]! * Math.max(groundSunMu, 0) * (GROUND_ALBEDO / Math.PI)) / directions.length;
          }
        }
      }
      const k = (j * n + i) * 4;
      for (let c = 0; c < 3; c += 1) {
        if (!(transfer[c]! < 1)) throw new Error(`buildMultipleScatteringTable: transfer ${transfer[c]} would not converge`);
        data[k + c] = second[c]! / (1 - transfer[c]!);
      }
      data[k + 3] = 1;
    }
  }
  return data;
}

/**
 * The sky shader's march on the CPU: `steps` samples crowded toward the viewer,
 * Hillaire's step integral, sunlight from the transmittance table and, when a
 * multiple-scattering table is given, its isotropic term. Per unit sun
 * illuminance, from radius r0 (viewer's up is +z) along unit `direction`.
 */
export function marchSky(p: AtmosphereParams, transmittance: Float32Array, multiple: Float32Array | null, r0: number, direction: Vec3, sun: Vec3, steps: number): { radiance: Rgb; transmittance: Rgb } {
  const { length } = rayLength(p, r0, direction.z);
  const cosTheta = direction.x * sun.x + direction.y * sun.y + direction.z * sun.z;
  const phaseR = rayleighPhase(cosTheta), phaseM = miePhase(p.mieAnisotropy, cosTheta);
  const t3 = [1, 1, 1], radiance = [0, 0, 0];
  for (let i = 0; i < steps; i += 1) {
    const s0 = i / steps, s1 = (i + 1) / steps, sm = (i + 0.5) / steps;
    const t = length * sm * sm, dt = length * (s1 * s1 - s0 * s0);
    const r = Math.sqrt(r0 * r0 + 2 * r0 * direction.z * t + t * t);
    const height = Math.max(0, r - p.bottomRadius);
    const d = densitiesAt(p, height);
    const e = extinctionAt(p, height);
    const sunMu = (r0 * sun.z + t * cosTheta) / r;
    const sunlight = sunlightAt(transmittance, p, r, sunMu);
    const ms = multiple ? multipleScatteringLookup(multiple, p, r, sunMu) : [0, 0, 0] as const;
    for (let c = 0; c < 3; c += 1) {
      const rayleigh = p.rayleighScattering[c as 0 | 1 | 2] * d.rayleigh, mie = p.mieScattering * d.mie;
      const source = (rayleigh * phaseR + mie * phaseM) * sunlight[c]! + (rayleigh + mie) * ms[c]!;
      const step = Math.exp(-e[c]! * dt);
      radiance[c]! += (t3[c]! * (source - source * step)) / e[c]!;
      t3[c]! *= step;
    }
  }
  return { radiance: [radiance[0]!, radiance[1]!, radiance[2]!], transmittance: [t3[0]!, t3[1]!, t3[2]!] };
}

/**
 * Irradiance from the whole sky (not the sun's direct beam) on level ground
 * at each height and sun angle, per unit sun illuminance: the sky's radiance,
 * with multiple scattering, weighted by the cosine over the upper hemisphere.
 */
export function buildIrradianceTable(p: AtmosphereParams, transmittance: Float32Array, multiple: Float32Array, directionCount = 128, steps = 24): Float32Array {
  const data = new Float32Array(IRRADIANCE_WIDTH * IRRADIANCE_HEIGHT * 4);
  const upper = sphereDirections(directionCount).filter((d) => d.z > 0);
  const solidAngle = (2 * Math.PI) / upper.length;
  for (let j = 0; j < IRRADIANCE_HEIGHT; j += 1) {
    for (let i = 0; i < IRRADIANCE_WIDTH; i += 1) {
      const sunMu = (i / (IRRADIANCE_WIDTH - 1)) * 2 - 1;
      const height = (j / (IRRADIANCE_HEIGHT - 1)) ** 2 * (p.topRadius - p.bottomRadius);
      const r0 = p.bottomRadius + Math.min(height, p.topRadius - p.bottomRadius - 1);
      const sun = { x: Math.sqrt(Math.max(0, 1 - sunMu * sunMu)), y: 0, z: sunMu };
      const sum = [0, 0, 0];
      for (const direction of upper) {
        const { radiance } = marchSky(p, transmittance, multiple, r0, direction, sun, steps);
        for (let c = 0; c < 3; c += 1) sum[c]! += radiance[c]! * direction.z * solidAngle;
      }
      const k = (j * IRRADIANCE_WIDTH + i) * 4;
      data[k] = sum[0]!;
      data[k + 1] = sum[1]!;
      data[k + 2] = sum[2]!;
      data[k + 3] = 1;
    }
  }
  return data;
}

/** Length of a ray from radius r0 with zenith cosine mu to the ground or the top of the air. */
export function rayLength(p: AtmosphereParams, r0: number, mu: number): { length: number; hitsGround: boolean } {
  if (rayHitsGround(p, r0, mu)) return { length: -r0 * mu - Math.sqrt(Math.max(0, r0 * r0 * (mu * mu - 1) + p.bottomRadius ** 2)), hitsGround: true };
  return { length: -r0 * mu + Math.sqrt(r0 * r0 * (mu * mu - 1) + p.topRadius ** 2), hitsGround: false };
}

function bilinear(table: Float32Array, width: number, height: number, x: number, y: number): Rgb {
  const fx = Math.min(1, Math.max(0, x)) * (width - 1), fy = Math.min(1, Math.max(0, y)) * (height - 1);
  const i = Math.min(width - 2, Math.floor(fx)), j = Math.min(height - 2, Math.floor(fy));
  const u = fx - i, v = fy - j;
  const at = (a: number, b: number, c: number) => table[(b * width + a) * 4 + c]!;
  const channel = (c: number) => (1 - v) * ((1 - u) * at(i, j, c) + u * at(i + 1, j, c)) + v * ((1 - u) * at(i, j + 1, c) + u * at(i + 1, j + 1, c));
  return [channel(0), channel(1), channel(2)];
}
