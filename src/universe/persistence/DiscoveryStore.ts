import { HERO_PLANET_ID, HERO_SYSTEM_ID } from "../types";
import {
  copySavedShipState,
  createEmptySave,
  DEFAULT_SAVE_STORAGE_KEY,
  isSafeSavedShipState,
  LEGACY_SAVE_SCHEMA_VERSION,
  LEGACY_SAVE_STORAGE_KEY,
  migrateUniverseSave,
  normalizeCelestialTimeScale,
  normalizeSavedSurfaceCheckpoint,
  SAVE_SCHEMA_VERSION,
  type SavedShipState,
  type SavedSurfaceCheckpoint,
  type SavedWaypoint,
  type UniverseSave,
} from "./SaveSchema";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStorage | undefined {
  try {
    return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Browser-owned discovery state; generation remains pure and independent. */
export class DiscoveryStore {
  private saveState: UniverseSave;
  private priorPlanetGeneratorVersion: number | undefined;
  private priorSaveSchemaVersion: number | undefined;
  private readonly storage: KeyValueStorage | undefined;
  private readonly storageKey: string;

  constructor(universeSeed: string | number, storage = browserStorage(), storageKey = DEFAULT_SAVE_STORAGE_KEY) {
    this.storage = storage;
    // An explicitly supplied old default is still an import source, never a
    // destination for the new schema.
    this.storageKey = storageKey === LEGACY_SAVE_STORAGE_KEY ? DEFAULT_SAVE_STORAGE_KEY : storageKey;
    this.saveState = this.load(universeSeed);
    this.discoverSystem(HERO_SYSTEM_ID, false);
    this.discoverBody(HERO_PLANET_ID, false);
  }

  get state(): Readonly<UniverseSave> {
    return this.saveState;
  }

  /** A genuine legacy save needs one body-fixed terrain reconciliation on restore. */
  get migratedFromPlanetGeneratorVersion(): number | undefined {
    return this.priorPlanetGeneratorVersion;
  }

  get migratedFromSaveSchemaVersion(): number | undefined {
    return this.priorSaveSchemaVersion;
  }

  get discoveredSystems(): readonly string[] {
    return this.saveState.discoveredSystemIds;
  }

  get discoveredBodies(): readonly string[] {
    return this.saveState.discoveredBodyIds;
  }

  discoverSystem(id: string, persist = true): boolean {
    if (this.saveState.discoveredSystemIds.includes(id)) return false;
    this.saveState.discoveredSystemIds.push(id);
    if (persist) this.flush();
    return true;
  }

  discoverBody(id: string, persist = true): boolean {
    if (this.saveState.discoveredBodyIds.includes(id)) return false;
    this.saveState.discoveredBodyIds.push(id);
    if (persist) this.flush();
    return true;
  }

  hasDiscoveredSystem(id: string): boolean {
    return this.saveState.discoveredSystemIds.includes(id);
  }

  hasDiscoveredBody(id: string): boolean {
    return this.saveState.discoveredBodyIds.includes(id);
  }

  setWaypoint(waypoint: SavedWaypoint): void {
    const index = this.saveState.waypoints.findIndex((entry) => entry.id === waypoint.id);
    if (index < 0) this.saveState.waypoints.push(waypoint);
    else this.saveState.waypoints[index] = waypoint;
    this.flush();
  }

  removeWaypoint(id: string): boolean {
    const index = this.saveState.waypoints.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.saveState.waypoints.splice(index, 1);
    this.flush();
    return true;
  }

  updateSimulationEpoch(seconds: number): void {
    this.saveState.simulationEpochSeconds = seconds;
  }

  /** Update both independent clocks in memory; saveShip flushes them atomically. */
  updateSimulationTiming(celestialTimeScale: number, localEffectsEpochSeconds: number): void {
    this.saveState.celestialTimeScale = normalizeCelestialTimeScale(celestialTimeScale);
    this.saveState.localEffectsEpochSeconds = Number.isFinite(localEffectsEpochSeconds)
      ? Math.max(0, localEffectsEpochSeconds)
      : Math.max(0, this.saveState.simulationEpochSeconds);
  }

  saveShip(ship: SavedShipState, surface?: SavedSurfaceCheckpoint): boolean {
    if (!isSafeSavedShipState(ship)) return false;
    const durableShip = copySavedShipState(ship);
    const durableSurface = normalizeSavedSurfaceCheckpoint(surface, durableShip);
    this.saveState.ship = copySavedShipState(durableShip, durableSurface);
    this.saveState.surface = durableSurface;
    return this.flush();
  }

  flush(): boolean {
    if (!this.storage) return false;
    const updatedAtEpochMs = Date.now();
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({ ...this.saveState, updatedAtEpochMs }));
      this.saveState.updatedAtEpochMs = updatedAtEpochMs;
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    const seed = this.saveState.universeSeed;
    try {
      this.storage?.removeItem(this.storageKey);
      // An explicit reset must not resurrect an old expedition on next boot.
      if (this.storageKey === DEFAULT_SAVE_STORAGE_KEY) this.storage?.removeItem(LEGACY_SAVE_STORAGE_KEY);
    } catch {
      // The current session still resets even if persistent storage is blocked.
    }
    this.saveState = createEmptySave(seed);
    this.priorPlanetGeneratorVersion = undefined;
    this.priorSaveSchemaVersion = undefined;
  }

  private load(seed: string | number): UniverseSave {
    if (!this.storage) return createEmptySave(seed);
    const keys = this.storageKey === DEFAULT_SAVE_STORAGE_KEY
      ? [this.storageKey, LEGACY_SAVE_STORAGE_KEY]
      : [this.storageKey];
    for (const key of keys) {
      try {
        const raw = this.storage.getItem(key);
        if (raw === null) continue;
        const parsed: unknown = JSON.parse(raw);
        const original = parsed as Partial<UniverseSave> | null;
        if (key === DEFAULT_SAVE_STORAGE_KEY && original?.schemaVersion !== SAVE_SCHEMA_VERSION) continue;
        if (key === LEGACY_SAVE_STORAGE_KEY && original?.schemaVersion !== LEGACY_SAVE_SCHEMA_VERSION) continue;
        const migrated = migrateUniverseSave(parsed);
        if (!migrated || migrated.universeSeed !== String(seed)) continue;
        if (original?.planetGeneratorVersion !== migrated.planetGeneratorVersion) {
          this.priorPlanetGeneratorVersion = original?.planetGeneratorVersion;
        }
        if (original?.schemaVersion !== migrated.schemaVersion) {
          this.priorSaveSchemaVersion = original?.schemaVersion;
        }
        return migrated;
      } catch {
        // Corrupt or inaccessible v2 storage must not prevent an authentic v1
        // import. Each known key gets its own independent read attempt.
      }
    }
    return createEmptySave(seed);
  }
}
