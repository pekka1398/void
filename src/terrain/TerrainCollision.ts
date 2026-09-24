import { Vector3 } from 'three';

import {
  createPlanetField,
  samplePlanetField,
  type PlanetField,
  type PlanetFieldInput,
  type PlanetSurfaceSample,
} from '../fields';

export interface LandingCheckOptions {
  horizontalSpeed?: number;
  verticalSpeed?: number;
  maxHorizontalSpeed?: number;
  maxVerticalSpeed?: number;
  maxSlopeDegrees?: number;
  tileReady?: boolean;
  /** Exact body-fixed ribbon occupancy, when the active procedural flow is available. */
  flowOccupied?: boolean;
}

export interface LandingCheck {
  safe: boolean;
  reason:
    | 'safe'
    | 'gas-giant'
    | 'water'
    | 'hazard'
    | 'slope'
    | 'horizontal-speed'
    | 'vertical-speed'
    | 'terrain-loading';
  surface: PlanetSurfaceSample;
  slopeDegrees: number;
}

export interface TerrainCollisionOptions {
  renderRadius?: number;
  radius?: number;
}

/** Surface queries use the exact same seeded body-fixed field as generated meshes. */
export class TerrainCollision {
  readonly field: PlanetField;
  readonly renderRadius: number;

  constructor(input: PlanetField | PlanetFieldInput, options: TerrainCollisionOptions = {}) {
    this.field = 'landable' in input ? input : createPlanetField(input);
    this.renderRadius = options.renderRadius ?? options.radius ?? this.field.radius;
  }

  sample(direction: { x: number; y: number; z: number }): PlanetSurfaceSample {
    return samplePlanetField(this.field, direction);
  }

  /** The resulting altitude is returned in truthful physical meters. */
  altitude(position: { x: number; y: number; z: number }): number {
    const distance = Math.hypot(position.x, position.y, position.z);
    const scale = this.field.radius / this.renderRadius;
    const surface = this.sample(position);
    return distance * scale - surface.radialMeters;
  }

  groundRadius(direction: { x: number; y: number; z: number }): number {
    const surface = this.sample(direction);
    return this.renderRadius * surface.radialMeters / this.field.radius;
  }

  surfaceNormal(directionInput: { x: number; y: number; z: number }): Vector3 {
    const direction = new Vector3(directionInput.x, directionInput.y, directionInput.z).normalize();
    const reference = Math.abs(direction.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const tangent = new Vector3().crossVectors(reference, direction).normalize();
    const bitangent = new Vector3().crossVectors(direction, tangent).normalize();
    const sampleAngle = Math.max(0.000_001, 12 / this.field.radius);
    const east = direction.clone().addScaledVector(tangent, sampleAngle).normalize();
    const west = direction.clone().addScaledVector(tangent, -sampleAngle).normalize();
    const north = direction.clone().addScaledVector(bitangent, sampleAngle).normalize();
    const south = direction.clone().addScaledVector(bitangent, -sampleAngle).normalize();
    const eastHeight = this.sample(east).heightMeters;
    const westHeight = this.sample(west).heightMeters;
    const northHeight = this.sample(north).heightMeters;
    const southHeight = this.sample(south).heightMeters;
    const sampleDistance = sampleAngle * this.field.radius * 2;

    return direction
      .clone()
      .addScaledVector(tangent, -(eastHeight - westHeight) / sampleDistance)
      .addScaledVector(bitangent, -(northHeight - southHeight) / sampleDistance)
      .normalize();
  }

  slopeDegrees(direction: { x: number; y: number; z: number }): number {
    const radial = new Vector3(direction.x, direction.y, direction.z).normalize();
    const normal = this.surfaceNormal(radial);
    return (Math.acos(Math.min(1, Math.max(-1, radial.dot(normal)))) * 180) / Math.PI;
  }

  evaluateLanding(
    direction: { x: number; y: number; z: number },
    options: LandingCheckOptions = {},
  ): LandingCheck {
    const surface = this.sample(direction);
    const slopeDegrees = this.slopeDegrees(direction);

    const result = (reason: LandingCheck['reason']): LandingCheck => ({
      safe: reason === 'safe',
      reason,
      surface,
      slopeDegrees,
    });

    if (!this.field.landable) return result('gas-giant');
    if (options.tileReady === false) return result('terrain-loading');
    if (surface.ocean) return result('water');
    if ((surface.riverStrength ?? 0) > 0.3 && options.flowOccupied !== false) return result('water');
    if ((surface.biome === 'lava' || (surface.lavaStrength ?? 0) > 0.32) &&
      options.flowOccupied !== false) {
      return result('hazard');
    }
    if (slopeDegrees > (options.maxSlopeDegrees ?? 26)) return result('slope');
    if (Math.abs(options.horizontalSpeed ?? 0) > (options.maxHorizontalSpeed ?? 24)) {
      return result('horizontal-speed');
    }
    if (Math.abs(options.verticalSpeed ?? 0) > (options.maxVerticalSpeed ?? 12)) {
      return result('vertical-speed');
    }

    return result('safe');
  }

  findCoastalLandingDirection(
    preferredDirection: { x: number; y: number; z: number },
    attempts = 96,
  ): Vector3 | null {
    const preferred = new Vector3(
      preferredDirection.x,
      preferredDirection.y,
      preferredDirection.z,
    ).normalize();
    const reference = Math.abs(preferred.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const tangent = new Vector3().crossVectors(reference, preferred).normalize();
    const bitangent = new Vector3().crossVectors(preferred, tangent).normalize();
    let bestDirection: Vector3 | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const dryCandidates: Array<{ direction: Vector3; heightMeters: number }> = [];
    const oceanCandidates: Vector3[] = [];

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const angle = attempt * 2.399_963_229_728_653;
      const spread = Math.sqrt(attempt / Math.max(1, attempts - 1)) * 0.7;
      const candidate = preferred
        .clone()
        .addScaledVector(tangent, Math.cos(angle) * spread)
        .addScaledVector(bitangent, Math.sin(angle) * spread)
        .normalize();
      const surface = this.sample(candidate);

      if (surface.ocean) {
        oceanCandidates.push(candidate);
        continue;
      }

      dryCandidates.push({ direction: candidate, heightMeters: surface.heightMeters });

      const score = Math.abs(surface.normalizedHeight - 0.0018) + surface.slopeHint * 0.015;
      if (score < bestScore) {
        bestScore = score;
        bestDirection = candidate;
      }
    }

    // A sparse global search may otherwise stop hundreds of meters inland, with
    // its actual shoreline beyond the visible horizon of a landed spacecraft.
    // Bracket one genuine wet/dry transition and solve the same authoritative
    // radial field to retain a dry landing point approximately 18 m above sea.
    let nearestDry: Vector3 | undefined;
    let nearestWet: Vector3 | undefined;
    let closestDistanceSquared = Number.POSITIVE_INFINITY;

    for (const dry of dryCandidates) {
      for (const wet of oceanCandidates) {
        const distanceSquared = dry.direction.distanceToSquared(wet);
        if (distanceSquared >= closestDistanceSquared) continue;
        closestDistanceSquared = distanceSquared;
        nearestDry = dry.direction;
        nearestWet = wet;
      }
    }

    if (nearestDry && nearestWet) {
      let dry = nearestDry.clone();
      let wet = nearestWet.clone();
      const interior = nearestDry.clone();

      for (let iteration = 0; iteration < 19; iteration += 1) {
        const halfway = dry.clone().add(wet).normalize();
        if (this.sample(halfway).ocean) wet = halfway;
        else dry = halfway;
      }

      let inland = interior;
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const halfway = dry.clone().add(inland).normalize();
        if (this.sample(halfway).heightMeters > 18) inland = halfway;
        else dry = halfway;
      }

      return inland;
    }

    return bestDirection;
  }
}
