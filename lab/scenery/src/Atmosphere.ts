/**
 * A planet's atmosphere as single scattering: Rayleigh (air), Mie (haze) and
 * ozone absorption, each with its own density profile. Everything here is in
 * metres and runs on the CPU: the transmittance table uploaded to the GPU, and
 * reference versions of what the shaders compute, for the headless check.
 *
 * The parameters and the table layout follow Hillaire's "A Scalable and
 * Production Ready Sky and Atmosphere Rendering Technique" (2020), which uses
 * Bruneton's Earth values.
 */
export type Rgb = readonly [number, number, number];

export interface AtmosphereParams {
  /** The ground sphere the air sits on (the planet's reference radius), metres. */
  readonly bottomRadius: number;
  /** Where the air is taken to end, metres from the centre. */
  readonly topRadius: number;
  /** Scattering at the bottom, per metre, for red, green and blue. */
  readonly rayleighScattering: Rgb;
  readonly rayleighScaleHeight: number;
  readonly mieScattering: number;
  /** Mie scatters most of what it removes; the rest is absorbed. */
  readonly mieExtinction: number;
  readonly mieScaleHeight: number;
  /** Mie phase asymmetry: 0 scatters evenly, near 1 mostly forward. */
  readonly mieAnisotropy: number;
  /** Ozone absorption at the peak of its layer, per metre. */
  readonly ozoneAbsorption: Rgb;
  /** Ozone density is a tent: 1 at this height, 0 at half the width above and below. */
  readonly ozoneCenterHeight: number;
  readonly ozoneWidth: number;
}

/** Earth's air over a planet of the given radius, 100 km deep. */
export function earthLikeAtmosphere(bottomRadius: number): AtmosphereParams {
  if (!(bottomRadius > 0)) throw new RangeError(`earthLikeAtmosphere: bottomRadius ${bottomRadius}`);
  return {
    bottomRadius,
    topRadius: bottomRadius + 100e3,
    rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
    rayleighScaleHeight: 8e3,
    mieScattering: 3.996e-6,
    mieExtinction: 4.44e-6,
    mieScaleHeight: 1.2e3,
    mieAnisotropy: 0.8,
    ozoneAbsorption: [0.65e-6, 1.881e-6, 0.085e-6],
    ozoneCenterHeight: 25e3,
    ozoneWidth: 30e3,
  };
}

export interface Densities { readonly rayleigh: number; readonly mie: number; readonly ozone: number }

/** Relative density of each constituent at a height above the bottom radius. */
export function densitiesAt(p: AtmosphereParams, height: number): Densities {
  return {
    rayleigh: Math.exp(-height / p.rayleighScaleHeight),
    mie: Math.exp(-height / p.mieScaleHeight),
    ozone: Math.max(0, 1 - Math.abs(height - p.ozoneCenterHeight) / (p.ozoneWidth / 2)),
  };
}

/** Extinction (scattering plus absorption) per metre at a height. */
export function extinctionAt(p: AtmosphereParams, height: number): Rgb {
  const d = densitiesAt(p, height);
  const channel = (c: 0 | 1 | 2) => p.rayleighScattering[c] * d.rayleigh + p.mieExtinction * d.mie + p.ozoneAbsorption[c] * d.ozone;
  return [channel(0), channel(1), channel(2)];
}

/** Distance along a ray from radius r with zenith cosine mu to where it leaves a sphere of `radius`; the ray starts inside it. */
export function distanceToSphereExit(r: number, mu: number, radius: number): number {
  const discriminant = r * r * (mu * mu - 1) + radius * radius;
  if (!(discriminant >= 0)) throw new RangeError(`distanceToSphereExit: r=${r} is outside radius=${radius}`);
  return Math.max(0, -r * mu + Math.sqrt(discriminant));
}

/** Whether a ray from radius r with zenith cosine mu hits the bottom sphere. */
export function rayHitsGround(p: AtmosphereParams, r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + p.bottomRadius * p.bottomRadius >= 0;
}

const TRANSMITTANCE_STEPS = 120;

/**
 * Transmittance from radius r along zenith cosine mu to the top of the air,
 * by the midpoint rule. Only for rays that miss the ground: one that hits it
 * never reaches the top, and asking is a bug.
 */
export function transmittanceToTop(p: AtmosphereParams, r: number, mu: number): Rgb {
  if (!(r >= p.bottomRadius && r <= p.topRadius) || !(mu >= -1 && mu <= 1)) throw new RangeError(`transmittanceToTop: r=${r}, mu=${mu}`);
  if (rayHitsGround(p, r, mu)) throw new RangeError(`transmittanceToTop: the ray from r=${r}, mu=${mu} hits the ground`);
  const length = distanceToSphereExit(r, mu, p.topRadius);
  const dt = length / TRANSMITTANCE_STEPS;
  let red = 0, green = 0, blue = 0;
  for (let i = 0; i < TRANSMITTANCE_STEPS; i += 1) {
    const t = (i + 0.5) * dt;
    const height = Math.sqrt(r * r + 2 * r * mu * t + t * t) - p.bottomRadius;
    const e = extinctionAt(p, height);
    red += e[0] * dt;
    green += e[1] * dt;
    blue += e[2] * dt;
  }
  return [Math.exp(-red), Math.exp(-green), Math.exp(-blue)];
}

/**
 * The transmittance table: 256 zenith cosines by 64 heights. Hillaire's
 * layout: x is where the ray leaves the air, between straight up and the
 * horizon; y is the distance to the horizon. Rows of heights near the ground
 * and columns near the horizon, where transmittance changes fastest, are the
 * densest.
 */
export const TRANSMITTANCE_WIDTH = 256;
export const TRANSMITTANCE_HEIGHT = 64;

/** Table coordinates (0–1 at the first and last texel centres) of a ray that misses the ground. */
export function transmittanceCoords(p: AtmosphereParams, r: number, mu: number): { x: number; y: number } {
  const horizon = Math.sqrt(p.topRadius ** 2 - p.bottomRadius ** 2);
  const rho = Math.sqrt(Math.max(0, r * r - p.bottomRadius ** 2));
  const d = distanceToSphereExit(r, mu, p.topRadius);
  const dMin = p.topRadius - r;
  const dMax = rho + horizon;
  return { x: (d - dMin) / (dMax - dMin), y: rho / horizon };
}

/** Inverse of transmittanceCoords. */
export function transmittanceRay(p: AtmosphereParams, x: number, y: number): { r: number; mu: number } {
  const horizon = Math.sqrt(p.topRadius ** 2 - p.bottomRadius ** 2);
  const rho = horizon * y;
  const r = Math.sqrt(rho * rho + p.bottomRadius ** 2);
  const dMin = p.topRadius - r;
  const dMax = rho + horizon;
  const d = dMin + x * (dMax - dMin);
  const mu = d === 0 ? 1 : (horizon * horizon - rho * rho - d * d) / (2 * r * d);
  return { r, mu: Math.min(1, Math.max(-1, mu)) };
}

/** RGBA float texels, row by row from y = 0; alpha is 1. */
export function buildTransmittanceTable(p: AtmosphereParams): Float32Array {
  const data = new Float32Array(TRANSMITTANCE_WIDTH * TRANSMITTANCE_HEIGHT * 4);
  for (let j = 0; j < TRANSMITTANCE_HEIGHT; j += 1) {
    for (let i = 0; i < TRANSMITTANCE_WIDTH; i += 1) {
      const { r, mu } = transmittanceRay(p, i / (TRANSMITTANCE_WIDTH - 1), j / (TRANSMITTANCE_HEIGHT - 1));
      // The horizon column of the bottom row grazes the ground; nudge it up by the float error of the inverse.
      const t = transmittanceToTop(p, r, rayHitsGround(p, r, mu) ? mu + 1e-12 : mu);
      const k = (j * TRANSMITTANCE_WIDTH + i) * 4;
      data[k] = t[0];
      data[k + 1] = t[1];
      data[k + 2] = t[2];
      data[k + 3] = 1;
    }
  }
  return data;
}

export function rayleighPhase(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
}

/** Cornette–Shanks phase function. */
export function miePhase(g: number, cosTheta: number): number {
  const k = (3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g));
  return (k * (1 + cosTheta * cosTheta)) / (1 + g * g - 2 * g * cosTheta) ** 1.5;
}

export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };

/**
 * Light scattered toward a viewer at `altitude` above the bottom radius,
 * looking along unit `direction` in the viewer's local frame (z up), from a
 * sun of illuminance 1 along unit `sun`: the reference for the sky shader, at
 * many more steps. Stops at the ground or the top of the air.
 */
export function skyRadiance(p: AtmosphereParams, altitude: number, direction: Vec3, sun: Vec3, steps = 2000): Rgb {
  const r0 = p.bottomRadius + altitude;
  if (!(r0 <= p.topRadius)) throw new RangeError(`skyRadiance: altitude ${altitude} is above the air`);
  const mu = direction.z;
  const length = rayHitsGround(p, r0, mu)
    ? -r0 * mu - Math.sqrt(r0 * r0 * (mu * mu - 1) + p.bottomRadius ** 2)
    : distanceToSphereExit(r0, mu, p.topRadius);
  const cosTheta = direction.x * sun.x + direction.y * sun.y + direction.z * sun.z;
  const phaseR = rayleighPhase(cosTheta);
  const phaseM = miePhase(p.mieAnisotropy, cosTheta);
  const dt = length / steps;
  const radiance = [0, 0, 0];
  const depth = [0, 0, 0];
  for (let i = 0; i < steps; i += 1) {
    const t = (i + 0.5) * dt;
    const px = direction.x * t, py = direction.y * t, pz = r0 + direction.z * t;
    const r = Math.hypot(px, py, pz);
    const height = r - p.bottomRadius;
    const e = extinctionAt(p, height);
    const d = densitiesAt(p, height);
    const sunMu = (px * sun.x + py * sun.y + pz * sun.z) / r;
    const toSun = rayHitsGround(p, r, sunMu) ? [0, 0, 0] as const : transmittanceToTop(p, Math.min(r, p.topRadius), sunMu);
    for (const c of [0, 1, 2] as const) {
      const viewT = Math.exp(-(depth[c]! + e[c] * dt / 2));
      const scattering = p.rayleighScattering[c] * d.rayleigh * phaseR + p.mieScattering * d.mie * phaseM;
      radiance[c]! += viewT * scattering * toSun[c] * dt;
      depth[c]! += e[c] * dt;
    }
  }
  return [radiance[0]!, radiance[1]!, radiance[2]!];
}
