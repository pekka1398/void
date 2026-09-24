import { hashUnit, type Vec3Like } from './noise';
import { samplePlanetClimate, type PlanetField, type PlanetSurfaceSample } from './PlanetField';
import {
  atmosphereSurfaceDensity,
  hasRenderableAtmosphere,
  supportsAtmosphericClouds,
  type PlanetCloudType,
  type PlanetDescriptor,
} from '../universe';

export const PLANET_CLIMATE_ATLAS_WIDTH = 64;
export const PLANET_CLIMATE_ATLAS_HEIGHT = 32;
export const PLANET_CLOUD_EXTINCTION = 1.42;
export const MINIMUM_CLOUD_TRANSMISSION = 0.18;

/** Exactly shared CPU/TSL weather shaping; changing either consumer alone is invalid. */
export const PLANET_WEATHER_SHAPING = Object.freeze({
  latitudeA: 3.1,
  latitudeB: 5.7,
  latitudeC: 8.9,
  latitudeFine: 11.7,
  structureA: 0.48,
  structureB: 0.34,
  structureC: 0.18,
  fineCross: 0.73,
  fineMix: 0.3,
  liftingHumidity: 0.38,
  liftingCoverage: 0.39,
  liftingOrographic: 0.23,
  densityStructure: 0.63,
  densityLifting: 0.37,
  densityBoost: 1.42,
  thresholdBase: 0.73,
  thresholdCoverage: 0.46,
  thresholdHumidity: 0.12,
  thresholdOrographic: 0.08,
  thresholdWidth: 0.24,
  stormStructure: 0.68,
  stormHumidity: 0.18,
  stormOrographic: 0.14,
  stormWidth: 0.22,
  opticalBase: 0.48,
  opticalHumidity: 0.31,
  opticalStorm: 0.21,
});

const TWO_PI = Math.PI * 2;

export interface PlanetClimateAtlas {
  readonly bodyId: string;
  readonly width: typeof PLANET_CLIMATE_ATLAS_WIDTH;
  readonly height: typeof PLANET_CLIMATE_ATLAS_HEIGHT;
  /** Body-fixed byte RGBA: humidity, cloud coverage, orographic lift, elevation. */
  readonly data: Uint8Array;
  readonly generated: boolean;
}

export interface PlanetWeatherClimate {
  readonly humidity: number;
  readonly coverage: number;
  readonly orographicLift: number;
  /** Signed real terrain height normalized by this body's maximum real relief. */
  readonly elevation: number;
}

export interface PlanetWeatherCoefficients {
  readonly phaseA: number;
  readonly phaseB: number;
  readonly phaseC: number;
  readonly phaseFine: number;
  readonly frequencyA: number;
  readonly frequencyB: number;
  readonly frequencyC: number;
  readonly frequencyFine: number;
  readonly windAngularVelocityRadiansPerSecond: number;
  readonly densityScale: number;
  readonly stormScale: number;
  readonly stormThreshold: number;
  readonly extinction: number;
  readonly minimumTransmission: number;
}

export interface PlanetWeatherDensity {
  readonly density: number;
  readonly stormIntensity: number;
  readonly windPhase: number;
}

export interface PlanetWeatherSample extends PlanetWeatherClimate, PlanetWeatherDensity {
  readonly bodyId: string;
  readonly cloudDensity: number;
  readonly precipitation: number;
  readonly opticalDepth: number;
  readonly cloudBaseMeters: number;
  readonly cloudTopMeters: number;
  readonly windSpeedMetersPerSecond: number;
  readonly timeSeconds: number;
}

export interface PlanetWeatherField {
  readonly bodyId: string;
  readonly seed: number;
  readonly radiusMeters: number;
  /** Collisional air and cloud formation are separate capabilities. */
  readonly hasAtmosphere: boolean;
  readonly supported: boolean;
  readonly atmosphereDensity: number;
  readonly atmosphereHeightMeters: number;
  readonly cloudType: PlanetCloudType;
  readonly cloudOpacityScale: number;
  readonly cloudBaseMeters: number;
  readonly cloudTopMeters: number;
  readonly windSpeedMetersPerSecond: number;
  readonly windDirection: Vec3Like;
  readonly windAngularVelocityRadiansPerSecond: number;
  readonly coefficients: PlanetWeatherCoefficients;
  readonly atlas: PlanetClimateAtlas;
  sample(bodyFixedDirection: Vec3Like, localEffectsSeconds: number): PlanetWeatherSample;
}

interface CachedPlanetWeather {
  readonly signature: string;
  readonly weather: PlanetWeatherField;
}

// One current profile per body/terrain field. Replacing a descriptor must not
// reuse stale weather, and repeated profile changes must not grow this cache.
const weatherCache = new WeakMap<PlanetField, Map<string, CachedPlanetWeather>>();

function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, value));
}

function normalize(direction: Vec3Like): Vec3Like {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > Number.EPSILON) || !Number.isFinite(length)) {
    return { x: 0, y: 1, z: 0 };
  }
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const blend = clamp((value - edge0) / Math.max(Number.EPSILON, edge1 - edge0));
  return blend * blend * (3 - 2 * blend);
}

function pack(value: number): number {
  return Math.round(clamp(value) * 255);
}

function directionFromAtlasCell(x: number, y: number): Vec3Like {
  const longitude = (x + 0.5) / PLANET_CLIMATE_ATLAS_WIDTH * TWO_PI - Math.PI;
  const latitude = (y + 0.5) / PLANET_CLIMATE_ATLAS_HEIGHT * Math.PI - Math.PI / 2;
  const planar = Math.cos(latitude);
  return {
    x: Math.sin(longitude) * planar,
    y: Math.sin(latitude),
    z: Math.cos(longitude) * planar,
  };
}

function sampleOrographicLift(sample: PlanetSurfaceSample, field: PlanetField): number {
  const mountain = sample.mountainStrength ?? Math.max(
    0,
    sample.heightMeters / Math.max(1, field.maxHeightMeters),
  );
  const canyon = sample.canyonStrength ?? 0;
  const altitude = Math.max(0, sample.heightMeters) / Math.max(1, field.maxHeightMeters);
  return clamp(sample.ridgeStrength * 0.43 + mountain * 0.31 + canyon * 0.1 + altitude * 0.24);
}

function createClimateAtlas(
  planet: PlanetDescriptor,
  field: PlanetField,
  supported: boolean,
): PlanetClimateAtlas {
  let bytes: Uint8Array | undefined;
  const descriptorCloudCoverage = clamp(planet.atmosphere.cloudCoverage);

  return Object.freeze({
    bodyId: planet.id,
    width: PLANET_CLIMATE_ATLAS_WIDTH,
    height: PLANET_CLIMATE_ATLAS_HEIGHT,
    get generated(): boolean {
      return bytes !== undefined;
    },
    get data(): Uint8Array {
      if (bytes) return bytes;
      bytes = new Uint8Array(PLANET_CLIMATE_ATLAS_WIDTH * PLANET_CLIMATE_ATLAS_HEIGHT * 4);
      if (!supported) return bytes;

      for (let y = 0; y < PLANET_CLIMATE_ATLAS_HEIGHT; y += 1) {
        for (let x = 0; x < PLANET_CLIMATE_ATLAS_WIDTH; x += 1) {
          const direction = directionFromAtlasCell(x, y);
          // This is exactly the collision/render field with only downhill-flow
          // finite differences omitted; weather never alters real terrain.
          const surface = samplePlanetClimate(field, direction);
          const humidity = clamp(surface.weatherHumidity ?? surface.moisture);
          const localCoverage = clamp(surface.cloudCoverage ?? descriptorCloudCoverage);
          const coverage = clamp(localCoverage * 0.69 + descriptorCloudCoverage * 0.31);
          const orographicLift = sampleOrographicLift(surface, field);
          const elevation = clamp(surface.heightMeters / Math.max(1, field.maxHeightMeters), -1, 1);
          const offset = (y * PLANET_CLIMATE_ATLAS_WIDTH + x) * 4;
          bytes[offset] = pack(humidity);
          bytes[offset + 1] = pack(coverage);
          bytes[offset + 2] = pack(orographicLift);
          bytes[offset + 3] = pack(elevation * 0.5 + 0.5);
        }
      }

      return bytes;
    },
  });
}

function wrappedIndex(value: number, width: number): number {
  return ((value % width) + width) % width;
}

/** Byte-exact CPU equivalent of repeat-X, clamp-Y linear-filtered RGBA texture sampling. */
export function sampleWeatherClimate(
  atlas: PlanetClimateAtlas,
  rawBodyFixedDirection: Vec3Like,
): PlanetWeatherClimate {
  const direction = normalize(rawBodyFixedDirection);
  const longitude = Math.atan2(direction.x, direction.z);
  const rawU = longitude / TWO_PI + 0.5;
  const u = rawU - Math.floor(rawU);
  const v = clamp(Math.asin(clamp(direction.y, -1, 1)) / Math.PI + 0.5);
  const horizontal = u * atlas.width - 0.5;
  const vertical = clamp(v * atlas.height - 0.5, 0, atlas.height - 1);
  const x0 = Math.floor(horizontal);
  const y0 = Math.floor(vertical);
  const xBlend = horizontal - x0;
  const yBlend = vertical - y0;
  const x1 = wrappedIndex(x0 + 1, atlas.width);
  const y1 = Math.min(y0 + 1, atlas.height - 1);
  const wrappedX0 = wrappedIndex(x0, atlas.width);
  const data = atlas.data;

  function channel(index: number): number {
    const topLeft = data[(y0 * atlas.width + wrappedX0) * 4 + index]! / 255;
    const topRight = data[(y0 * atlas.width + x1) * 4 + index]! / 255;
    const bottomLeft = data[(y1 * atlas.width + wrappedX0) * 4 + index]! / 255;
    const bottomRight = data[(y1 * atlas.width + x1) * 4 + index]! / 255;
    const top = topLeft + (topRight - topLeft) * xBlend;
    const bottom = bottomLeft + (bottomRight - bottomLeft) * xBlend;
    return top + (bottom - top) * yBlend;
  }

  return {
    humidity: clamp(channel(0)),
    coverage: clamp(channel(1)),
    orographicLift: clamp(channel(2)),
    elevation: clamp(channel(3) * 2 - 1, -1, 1),
  };
}

/**
 * Seam-free analytic moving cloud density. Static climate remains body-fixed;
 * only the density pattern advects at the actual wind speed on local 1× time.
 */
export function sampleWeatherDensity(
  coefficients: PlanetWeatherCoefficients,
  climate: PlanetWeatherClimate,
  rawBodyFixedDirection: Vec3Like,
  localEffectsSeconds: number,
): PlanetWeatherDensity {
  const direction = normalize(rawBodyFixedDirection);
  const time = Number.isFinite(localEffectsSeconds) ? Math.max(0, localEffectsSeconds) : 0;
  const windPhase = time * coefficients.windAngularVelocityRadiansPerSecond;
  const cosine = Math.cos(windPhase);
  const sine = Math.sin(windPhase);
  const x = cosine * direction.x + sine * direction.z;
  const z = cosine * direction.z - sine * direction.x;
  const y = direction.y;

  const first = Math.sin(
    x * coefficients.frequencyA + z * coefficients.frequencyB +
      y * PLANET_WEATHER_SHAPING.latitudeA + coefficients.phaseA,
  ) * 0.5 + 0.5;
  const second = Math.sin(
    z * coefficients.frequencyB - x * coefficients.frequencyC +
      y * PLANET_WEATHER_SHAPING.latitudeB + coefficients.phaseB,
  ) * 0.5 + 0.5;
  const third = Math.sin(
    (x + z) * coefficients.frequencyC +
      y * PLANET_WEATHER_SHAPING.latitudeC + coefficients.phaseC,
  ) * 0.5 + 0.5;
  const broadStructure = first * PLANET_WEATHER_SHAPING.structureA +
    second * PLANET_WEATHER_SHAPING.structureB +
    third * PLANET_WEATHER_SHAPING.structureC;
  // A genuine few-kilometer breakup follows the same real wind. Broad fronts
  // remain geographic while nearby cloud edges visibly cross actual terrain.
  const fine = Math.sin(
    x * coefficients.frequencyFine +
      z * coefficients.frequencyFine * PLANET_WEATHER_SHAPING.fineCross +
      y * PLANET_WEATHER_SHAPING.latitudeFine + coefficients.phaseFine,
  ) * 0.5 + 0.5;
  const structure = broadStructure * (1 - PLANET_WEATHER_SHAPING.fineMix) +
    fine * PLANET_WEATHER_SHAPING.fineMix;
  const lifting = climate.humidity * PLANET_WEATHER_SHAPING.liftingHumidity +
    climate.coverage * PLANET_WEATHER_SHAPING.liftingCoverage +
    climate.orographicLift * PLANET_WEATHER_SHAPING.liftingOrographic;
  const threshold = clamp(
    PLANET_WEATHER_SHAPING.thresholdBase -
      climate.coverage * PLANET_WEATHER_SHAPING.thresholdCoverage -
      climate.humidity * PLANET_WEATHER_SHAPING.thresholdHumidity -
      climate.orographicLift * PLANET_WEATHER_SHAPING.thresholdOrographic,
    0.08,
    0.86,
  );
  const physicalCloudPresence = smoothstep(
    threshold,
    threshold + PLANET_WEATHER_SHAPING.thresholdWidth,
    structure,
  );
  const density = clamp(
    physicalCloudPresence *
      (structure * PLANET_WEATHER_SHAPING.densityStructure +
        lifting * PLANET_WEATHER_SHAPING.densityLifting) *
      climate.coverage * coefficients.densityScale * PLANET_WEATHER_SHAPING.densityBoost,
  );
  const stormIntensity = smoothstep(
    coefficients.stormThreshold,
    coefficients.stormThreshold + PLANET_WEATHER_SHAPING.stormWidth,
    structure * PLANET_WEATHER_SHAPING.stormStructure +
      climate.humidity * PLANET_WEATHER_SHAPING.stormHumidity +
      climate.orographicLift * PLANET_WEATHER_SHAPING.stormOrographic,
  ) * coefficients.stormScale;

  return { density, stormIntensity, windPhase };
}

function noWeather(field: PlanetWeatherField, localEffectsSeconds: number): PlanetWeatherSample {
  return {
    bodyId: field.bodyId,
    humidity: 0,
    coverage: 0,
    orographicLift: 0,
    elevation: 0,
    density: 0,
    cloudDensity: 0,
    stormIntensity: 0,
    windPhase: (Number.isFinite(localEffectsSeconds) ? Math.max(0, localEffectsSeconds) : 0) *
      field.windAngularVelocityRadiansPerSecond,
    precipitation: 0,
    opticalDepth: 0,
    cloudBaseMeters: 0,
    cloudTopMeters: 0,
    windSpeedMetersPerSecond: field.windSpeedMetersPerSecond,
    timeSeconds: Number.isFinite(localEffectsSeconds) ? Math.max(0, localEffectsSeconds) : 0,
  };
}

/** One authoritative body-fixed sample for clouds, storm cover, oceans, and terrain shadows. */
export function samplePlanetWeather(
  field: PlanetWeatherField,
  bodyFixedDirection: Vec3Like,
  localEffectsSeconds: number,
): PlanetWeatherSample {
  if (!field.supported) return noWeather(field, localEffectsSeconds);

  const climate = sampleWeatherClimate(field.atlas, bodyFixedDirection);
  const moving = sampleWeatherDensity(
    field.coefficients,
    climate,
    bodyFixedDirection,
    localEffectsSeconds,
  );
  const precipitation = clamp(
    (climate.humidity - 0.56) * moving.stormIntensity * climate.coverage * 2.8,
  );
  const opticalDepth = clamp(
    moving.density * field.coefficients.extinction *
      (PLANET_WEATHER_SHAPING.opticalBase +
        climate.humidity * PLANET_WEATHER_SHAPING.opticalHumidity +
        moving.stormIntensity * PLANET_WEATHER_SHAPING.opticalStorm),
    0,
    field.coefficients.extinction,
  );

  return {
    bodyId: field.bodyId,
    ...climate,
    ...moving,
    cloudDensity: moving.density,
    precipitation,
    opticalDepth,
    cloudBaseMeters: field.cloudBaseMeters,
    cloudTopMeters: field.cloudTopMeters,
    windSpeedMetersPerSecond: field.windSpeedMetersPerSecond,
    timeSeconds: Number.isFinite(localEffectsSeconds) ? Math.max(0, localEffectsSeconds) : 0,
  };
}

/** Create/cache one renderer-independent deterministic physical weather field per actual body. */
export function createPlanetWeather(
  planet: PlanetDescriptor,
  field: PlanetField,
): PlanetWeatherField {
  const atmosphere = planet.atmosphere;
  const signature = JSON.stringify([
    planet.seed, planet.radiusMeters, planet.rotationPeriodSeconds,
    atmosphere.generatorVersion, atmosphere.regime, atmosphere.surfacePressurePascals,
    atmosphere.density, atmosphere.heightMeters, atmosphere.cloudCoverage,
    atmosphere.cloudType, atmosphere.cloudBaseMeters, atmosphere.cloudTopMeters,
    atmosphere.cloudOpacityScale,
  ]);
  const cached = weatherCache.get(field)?.get(planet.id);
  if (cached?.signature === signature) return cached.weather;

  const hasAtmosphere = hasRenderableAtmosphere(atmosphere);
  const supported = supportsAtmosphericClouds(atmosphere);
  const cloudBaseMeters = supported ? atmosphere.cloudBaseMeters : 0;
  const cloudTopMeters = supported ? atmosphere.cloudTopMeters : 0;
  const cloudOpacityScale = supported ? clamp(atmosphere.cloudOpacityScale) : 0;
  const windSpeedMetersPerSecond = hasAtmosphere
    ? Math.min(38, 4 + TWO_PI * planet.radiusMeters /
      Math.max(1, planet.rotationPeriodSeconds) * 0.095)
    : 0;
  const windAngularVelocityRadiansPerSecond = windSpeedMetersPerSecond /
    Math.max(1, planet.radiusMeters);
  const heading = hashUnit(planet.seed ^ 0x53c4_a1e7) * TWO_PI;
  const coefficients: PlanetWeatherCoefficients = Object.freeze({
    phaseA: hashUnit(planet.seed ^ 0x41f3_2a17) * TWO_PI,
    phaseB: hashUnit(planet.seed ^ 0x8bc7_91e3) * TWO_PI,
    phaseC: hashUnit(planet.seed ^ 0xd293_6c4f) * TWO_PI,
    phaseFine: hashUnit(planet.seed ^ 0x39eb_7425) * TWO_PI,
    frequencyA: 32 + hashUnit(planet.seed ^ 0x73d1_43b9) * 14,
    frequencyB: 55 + hashUnit(planet.seed ^ 0x15ab_c927) * 21,
    frequencyC: 103 + hashUnit(planet.seed ^ 0xb541_e6a3) * 37,
    frequencyFine: 1_350 + hashUnit(planet.seed ^ 0xa971_58cf) * 900,
    windAngularVelocityRadiansPerSecond,
    densityScale: clamp(
      0.8 + planet.atmosphere.density * 0.48 + planet.atmosphere.cloudCoverage * 0.3,
      0.7,
      1.65,
    ) * cloudOpacityScale,
    stormScale: cloudOpacityScale,
    stormThreshold: 0.48 + hashUnit(planet.seed ^ 0x64b7_331d) * 0.13,
    extinction: PLANET_CLOUD_EXTINCTION,
    minimumTransmission: MINIMUM_CLOUD_TRANSMISSION,
  });
  const atlas = createClimateAtlas(planet, field, supported);
  let weather: PlanetWeatherField;
  weather = Object.freeze({
    bodyId: planet.id,
    seed: planet.seed,
    radiusMeters: planet.radiusMeters,
    hasAtmosphere,
    supported,
    atmosphereDensity: atmosphereSurfaceDensity(atmosphere),
    atmosphereHeightMeters: hasAtmosphere ? atmosphere.heightMeters : 0,
    cloudType: supported ? atmosphere.cloudType : 'none',
    cloudOpacityScale,
    cloudBaseMeters,
    cloudTopMeters,
    windSpeedMetersPerSecond,
    windDirection: Object.freeze({ x: Math.cos(heading), y: 0, z: Math.sin(heading) }),
    windAngularVelocityRadiansPerSecond,
    coefficients,
    atlas,
    sample(direction: Vec3Like, localEffectsSeconds: number): PlanetWeatherSample {
      return samplePlanetWeather(weather, direction, localEffectsSeconds);
    },
  });

  let byBody = weatherCache.get(field);
  if (!byBody) {
    byBody = new Map<string, CachedPlanetWeather>();
    weatherCache.set(field, byBody);
  }
  byBody.set(planet.id, { signature, weather });
  return weather;
}
