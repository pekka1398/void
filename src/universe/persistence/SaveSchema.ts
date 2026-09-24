import { CELL_SIZE_METERS, deserializeAddress, lengthVec3, type SerializedGalacticAddress, type Vec3 } from "../../core";
import type { SurfaceActorState } from "../../simulation/player/OnFootController";
import type { BodyFixedLandingAnchor, ParkedShipAnchor } from "../../simulation/ship/ShipState";
import { ATMOSPHERE_GENERATOR_VERSION, DEFAULT_UNIVERSE_SEED, PLANET_GENERATOR_VERSION, UNIVERSE_GENERATOR_VERSION } from "../types";

export const SAVE_SCHEMA_VERSION = 2;
export const LEGACY_SAVE_SCHEMA_VERSION = 1;
export const DEFAULT_SAVE_STORAGE_KEY = "void-explorer:save:v2";
export const LEGACY_SAVE_STORAGE_KEY = "void-explorer:save:v1";
export const DEFAULT_CELESTIAL_TIME_SCALE = 5;
export const MINIMUM_CELESTIAL_TIME_SCALE = 1;
export const MAXIMUM_CELESTIAL_TIME_SCALE = 8;

export interface SavedWaypoint {
  id: string;
  targetId: string;
  label: string;
  systemId: string;
  latitudeRadians?: number;
  longitudeRadians?: number;
  createdAtSeconds: number;
}

/** Durable data uses the same meter-space contracts as the simulation. */
export type SavedLandingAnchor = BodyFixedLandingAnchor;
export type SavedParkedShipAnchor = ParkedShipAnchor;
export type SavedSurfaceActorState = SurfaceActorState;

export interface SavedShipState {
  position: SerializedGalacticAddress;
  velocityMetersPerSecond: Vec3;
  heading: Vec3;
  activeSystemId: string;
  landedBodyId?: string;
  targetId?: string;
  yawRadians?: number;
  pitchRadians?: number;
  /** Compatibility projection; the v2 rich parked anchor lives in surface. */
  landedAnchor?: SavedLandingAnchor;
}

export type SavedSurfaceCheckpoint =
  | { kind: "airborne"; occupancy: "inside" }
  | { kind: "parked"; occupancy: "inside"; anchor: SavedParkedShipAnchor; legacyAnchor?: never; actor?: never }
  | { kind: "parked"; occupancy: "outside"; anchor: SavedParkedShipAnchor; legacyAnchor?: never; actor: SavedSurfaceActorState }
  /** A v1 anchor must be re-assessed against actual gear contacts before exit. */
  | { kind: "parked"; occupancy: "inside"; anchor?: never; legacyAnchor: SavedLandingAnchor; actor?: never };

export interface UniverseSave {
  schemaVersion: number;
  universeSeed: string;
  catalogGeneratorVersion: number;
  planetGeneratorVersion: number;
  /** Historical v1/v2 records omit this; every new or migrated save records it. */
  atmosphereGeneratorVersion?: number;
  simulationEpochSeconds: number;
  celestialTimeScale?: number;
  /** Independent one-to-one local animation clock; absent in legacy saves. */
  localEffectsEpochSeconds?: number;
  discoveredSystemIds: string[];
  discoveredBodyIds: string[];
  waypoints: SavedWaypoint[];
  ship?: SavedShipState;
  /** Only stable states are serialized, never runtime transition state. */
  surface?: SavedSurfaceCheckpoint;
  updatedAtEpochMs: number;
}

export function createEmptySave(universeSeed: string | number = DEFAULT_UNIVERSE_SEED): UniverseSave {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    universeSeed: String(universeSeed),
    catalogGeneratorVersion: UNIVERSE_GENERATOR_VERSION,
    planetGeneratorVersion: PLANET_GENERATOR_VERSION,
    atmosphereGeneratorVersion: ATMOSPHERE_GENERATOR_VERSION,
    simulationEpochSeconds: 0,
    celestialTimeScale: DEFAULT_CELESTIAL_TIME_SCALE,
    localEffectsEpochSeconds: 0,
    discoveredSystemIds: [],
    discoveredBodyIds: [],
    waypoints: [],
    updatedAtEpochMs: 0,
  };
}

/** Invalid or absent legacy preferences do not invalidate a real save. */
export function normalizeCelestialTimeScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MINIMUM_CELESTIAL_TIME_SCALE, Math.min(MAXIMUM_CELESTIAL_TIME_SCALE, value))
    : DEFAULT_CELESTIAL_TIME_SCALE;
}

export function isValidSave(value: unknown): value is UniverseSave {
  return hasValidSaveShape(value, SAVE_SCHEMA_VERSION, PLANET_GENERATOR_VERSION);
}

/**
 * Import only known historical schemas/generators. This is a pure conversion:
 * DiscoveryStore decides when a new v2 record has actually reached storage.
 */
export function migrateUniverseSave(value: unknown): UniverseSave | undefined {
  if (!isRecord(value)) return undefined;
  const schema = value.schemaVersion;
  const planetVersion = value.planetGeneratorVersion;
  if (
    (schema !== LEGACY_SAVE_SCHEMA_VERSION && schema !== SAVE_SCHEMA_VERSION) ||
    (planetVersion !== 1 && planetVersion !== PLANET_GENERATOR_VERSION) ||
    !hasValidSaveShape(value, schema, planetVersion)
  ) return undefined;

  const sourceShip = isSafeSavedShipState(value.ship) ? copySavedShipState(value.ship) : undefined;
  const surface = sourceShip
    ? normalizeSavedSurfaceCheckpoint(schema === SAVE_SCHEMA_VERSION ? value.surface : undefined, sourceShip)
    : undefined;
  const ship = sourceShip ? copySavedShipState(sourceShip, surface) : undefined;
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    universeSeed: value.universeSeed,
    catalogGeneratorVersion: value.catalogGeneratorVersion,
    planetGeneratorVersion: PLANET_GENERATOR_VERSION,
    atmosphereGeneratorVersion: ATMOSPHERE_GENERATOR_VERSION,
    simulationEpochSeconds: value.simulationEpochSeconds,
    ...(value.celestialTimeScale !== undefined ? { celestialTimeScale: value.celestialTimeScale } : {}),
    ...(value.localEffectsEpochSeconds !== undefined ? { localEffectsEpochSeconds: value.localEffectsEpochSeconds } : {}),
    discoveredSystemIds: [...value.discoveredSystemIds],
    discoveredBodyIds: [...value.discoveredBodyIds],
    waypoints: value.waypoints.map(copySavedWaypoint),
    ...(ship ? { ship, surface } : {}),
    updatedAtEpochMs: Number.isFinite(value.updatedAtEpochMs) ? value.updatedAtEpochMs : 0,
  };
}

function hasValidSaveShape(value: unknown, schemaVersion: number, planetGeneratorVersion: number): value is UniverseSave {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === schemaVersion &&
    typeof value.universeSeed === "string" &&
    value.catalogGeneratorVersion === UNIVERSE_GENERATOR_VERSION &&
    value.planetGeneratorVersion === planetGeneratorVersion &&
    (value.atmosphereGeneratorVersion === undefined ||
      value.atmosphereGeneratorVersion === ATMOSPHERE_GENERATOR_VERSION) &&
    typeof value.simulationEpochSeconds === "number" && Number.isFinite(value.simulationEpochSeconds) &&
    Array.isArray(value.discoveredSystemIds) &&
    value.discoveredSystemIds.every((entry) => typeof entry === "string") &&
    Array.isArray(value.discoveredBodyIds) &&
    value.discoveredBodyIds.every((entry) => typeof entry === "string") &&
    Array.isArray(value.waypoints) && value.waypoints.every(isSafeSavedWaypoint)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFiniteSavedVector(value: unknown): value is Vec3 {
  return isRecord(value) &&
    typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y) &&
    typeof value.z === "number" && Number.isFinite(value.z);
}

function isNonzeroVector(value: unknown): value is Vec3 {
  return isFiniteSavedVector(value) && lengthVec3(value) > 1e-8;
}

function isSafeSavedWaypoint(value: unknown): value is SavedWaypoint {
  return isRecord(value) && typeof value.id === "string" && typeof value.targetId === "string" &&
    typeof value.label === "string" && typeof value.systemId === "string" &&
    typeof value.createdAtSeconds === "number" && Number.isFinite(value.createdAtSeconds) &&
    (value.latitudeRadians === undefined || typeof value.latitudeRadians === "number" && Number.isFinite(value.latitudeRadians)) &&
    (value.longitudeRadians === undefined || typeof value.longitudeRadians === "number" && Number.isFinite(value.longitudeRadians));
}

function copySavedWaypoint(value: SavedWaypoint): SavedWaypoint {
  return {
    id: value.id,
    targetId: value.targetId,
    label: value.label,
    systemId: value.systemId,
    createdAtSeconds: value.createdAtSeconds,
    ...(value.latitudeRadians !== undefined ? { latitudeRadians: value.latitudeRadians } : {}),
    ...(value.longitudeRadians !== undefined ? { longitudeRadians: value.longitudeRadians } : {}),
  };
}

/** Structural ship validation shared by boot, launch presentation, and writes. */
export function isSafeSavedShipState(value: unknown): value is SavedShipState {
  if (!isRecord(value) || !isRecord(value.position)) return false;
  const position = value.position;
  if (!Array.isArray(position.cell) || position.cell.length !== 3 ||
    !position.cell.every((component) => typeof component === "string" && /^-?\d+$/.test(component))) return false;
  if (!isFiniteSavedVector(position.localMeters) || !isFiniteSavedVector(value.velocityMetersPerSecond) ||
    !isNonzeroVector(value.heading) || typeof value.activeSystemId !== "string") return false;
  try {
    const normalized = deserializeAddress(position as unknown as SerializedGalacticAddress).localMeters;
    return isFiniteSavedVector(normalized) && [normalized.x, normalized.y, normalized.z]
      .every((component) => component >= 0 && component < CELL_SIZE_METERS);
  } catch {
    return false;
  }
}

export function isSafeSavedLandingAnchor(value: unknown): value is SavedLandingAnchor {
  return isRecord(value) && typeof value.bodyId === "string" &&
    isNonzeroVector(value.surfaceDirection) &&
    typeof value.altitudeMeters === "number" && Number.isFinite(value.altitudeMeters) &&
    typeof value.latitudeRadians === "number" && Number.isFinite(value.latitudeRadians) &&
    typeof value.longitudeRadians === "number" && Number.isFinite(value.longitudeRadians);
}

export function isSafeSavedParkedAnchor(value: unknown): value is SavedParkedShipAnchor {
  if (!isRecord(value) || typeof value.bodyId !== "string" ||
    !isNonzeroVector(value.bodyFixedOriginMeters) || !isNonzeroVector(value.bodyFixedForward) ||
    !isNonzeroVector(value.supportNormalBodyFixed) ||
    !Number.isSafeInteger(value.surfaceKitVersion) || (value.surfaceKitVersion as number) < 1 ||
    !Array.isArray(value.padContacts) || value.padContacts.length < 3 || value.padContacts.length > 16) return false;
  const ids = new Set<string>();
  for (const pad of value.padContacts) {
    if (!isRecord(pad) || typeof pad.padId !== "string" || ids.has(pad.padId) ||
      !isFiniteSavedVector(pad.bodyFixedPointMeters) || !isNonzeroVector(pad.bodyFixedNormal) ||
      typeof pad.compressionMeters !== "number" || !Number.isFinite(pad.compressionMeters) || pad.compressionMeters < 0) return false;
    ids.add(pad.padId);
  }
  return true;
}

export function isSafeSavedSurfaceActor(value: unknown): value is SavedSurfaceActorState {
  return isRecord(value) && typeof value.systemId === "string" && typeof value.bodyId === "string" &&
    isNonzeroVector(value.bodyFixedCenterMeters) && isFiniteSavedVector(value.bodyFixedVelocityMetersPerSecond) &&
    isNonzeroVector(value.tangentForwardBodyFixed) && typeof value.lookPitchRadians === "number" &&
    Number.isFinite(value.lookPitchRadians) && Math.abs(value.lookPitchRadians) <= Math.PI / 2 + 1e-6 &&
    typeof value.grounded === "boolean";
}

export function copySavedLandingAnchor(anchor: SavedLandingAnchor): SavedLandingAnchor {
  return {
    bodyId: anchor.bodyId,
    surfaceDirection: { ...anchor.surfaceDirection },
    altitudeMeters: anchor.altitudeMeters,
    latitudeRadians: anchor.latitudeRadians,
    longitudeRadians: anchor.longitudeRadians,
  };
}

export function copySavedParkedAnchor(anchor: SavedParkedShipAnchor): SavedParkedShipAnchor {
  return {
    bodyId: anchor.bodyId,
    bodyFixedOriginMeters: { ...anchor.bodyFixedOriginMeters },
    bodyFixedForward: { ...anchor.bodyFixedForward },
    supportNormalBodyFixed: { ...anchor.supportNormalBodyFixed },
    padContacts: anchor.padContacts.map((pad) => ({
      padId: pad.padId,
      bodyFixedPointMeters: { ...pad.bodyFixedPointMeters },
      bodyFixedNormal: { ...pad.bodyFixedNormal },
      compressionMeters: pad.compressionMeters,
    })),
    surfaceKitVersion: anchor.surfaceKitVersion,
  };
}

export function copySavedSurfaceActor(actor: SavedSurfaceActorState): SavedSurfaceActorState {
  return {
    systemId: actor.systemId,
    bodyId: actor.bodyId,
    bodyFixedCenterMeters: { ...actor.bodyFixedCenterMeters },
    bodyFixedVelocityMetersPerSecond: { ...actor.bodyFixedVelocityMetersPerSecond },
    tangentForwardBodyFixed: { ...actor.tangentForwardBodyFixed },
    lookPitchRadians: actor.lookPitchRadians,
    grounded: actor.grounded,
  };
}

export function copySavedSurfaceCheckpoint(checkpoint: SavedSurfaceCheckpoint): SavedSurfaceCheckpoint {
  if (checkpoint.kind === "airborne") return { kind: "airborne", occupancy: "inside" };
  if (!checkpoint.anchor) {
    return { kind: "parked", occupancy: "inside", legacyAnchor: copySavedLandingAnchor(checkpoint.legacyAnchor) };
  }
  const anchor = copySavedParkedAnchor(checkpoint.anchor);
  return checkpoint.occupancy === "outside"
    ? { kind: "parked", occupancy: "outside", anchor, actor: copySavedSurfaceActor(checkpoint.actor) }
    : { kind: "parked", occupancy: "inside", anchor };
}

export function copySavedShipState(ship: SavedShipState, surface?: SavedSurfaceCheckpoint): SavedShipState {
  const copied: SavedShipState = {
    position: { cell: [...ship.position.cell], localMeters: { ...ship.position.localMeters } },
    velocityMetersPerSecond: { ...ship.velocityMetersPerSecond },
    heading: { ...ship.heading },
    activeSystemId: ship.activeSystemId,
    ...(typeof ship.landedBodyId === "string" ? { landedBodyId: ship.landedBodyId } : {}),
    ...(typeof ship.targetId === "string" ? { targetId: ship.targetId } : {}),
    ...(typeof ship.yawRadians === "number" && Number.isFinite(ship.yawRadians) ? { yawRadians: ship.yawRadians } : {}),
    ...(typeof ship.pitchRadians === "number" && Number.isFinite(ship.pitchRadians) ? { pitchRadians: ship.pitchRadians } : {}),
    ...(isSafeSavedLandingAnchor(ship.landedAnchor) ? { landedAnchor: copySavedLandingAnchor(ship.landedAnchor) } : {}),
  };
  if (surface?.kind === "airborne") {
    delete copied.landedBodyId;
    delete copied.landedAnchor;
  } else if (surface?.kind === "parked") {
    const bodyId = surface.anchor?.bodyId ?? surface.legacyAnchor!.bodyId;
    copied.landedBodyId = bodyId;
    if (surface.legacyAnchor) copied.landedAnchor = copySavedLandingAnchor(surface.legacyAnchor);
    else if (copied.landedAnchor?.bodyId !== bodyId) delete copied.landedAnchor;
  }
  return copied;
}

/**
 * Strip runtime-only fields and recover a bad actor independently of a good
 * ship. Catalog/hazard/contact eligibility is checked before actual restore.
 */
export function normalizeSavedSurfaceCheckpoint(value: unknown, ship: SavedShipState): SavedSurfaceCheckpoint {
  if (isRecord(value) && value.kind === "parked" && isSafeSavedParkedAnchor(value.anchor)) {
    const anchor = copySavedParkedAnchor(value.anchor);
    if (value.occupancy === "outside" && isSafeSavedSurfaceActor(value.actor) &&
      value.actor.bodyId === anchor.bodyId && value.actor.systemId === ship.activeSystemId) {
      return { kind: "parked", occupancy: "outside", anchor, actor: copySavedSurfaceActor(value.actor) };
    }
    return { kind: "parked", occupancy: "inside", anchor };
  }
  if (isRecord(value) && value.kind === "airborne") return { kind: "airborne", occupancy: "inside" };
  const legacyAnchor = isRecord(value) && value.kind === "parked" && isSafeSavedLandingAnchor(value.legacyAnchor)
    ? value.legacyAnchor
    : isSafeSavedLandingAnchor(ship.landedAnchor) ? ship.landedAnchor : undefined;
  return legacyAnchor
    ? { kind: "parked", occupancy: "inside", legacyAnchor: copySavedLandingAnchor(legacyAnchor) }
    : { kind: "airborne", occupancy: "inside" };
}
