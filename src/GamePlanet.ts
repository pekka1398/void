import { planetById, type LandingPlanet } from './landingCore';
import { terrainFromConfig } from '../lab/landing/src/terrain/TerrainConfig';
import { DEFAULT_LAYERED, SEA_LEVEL } from '../lab/scenery/src/LayeredTerrain';

export type GameTerrainId = 'layered' | 'hills';
export interface GamePlanet {
  planet: LandingPlanet;
  terrainId: GameTerrainId;
  atmosphere: boolean;
  ocean: boolean;
  seaLevel: number;
  rockHeight: number;
  snowHeight: number;
  launchSite: { x: number; y: number; z: number } | null;
}

/** Only the Earth analogues have air and water; lone small-body labs stay airless. */
export function gamePlanetById(id: string, requestedTerrain?: string | null): GamePlanet {
  const original = planetById(id);
  const hasAir = ['aurelia', 'aurelia-fast', 'terra'].includes(id);
  const terrainId = requestedTerrain ?? (hasAir ? 'layered' : 'hills');
  if (terrainId !== 'layered' && terrainId !== 'hills') throw new Error(`GamePlanet: unknown terrain ${JSON.stringify(terrainId)}`);
  if (terrainId === 'layered' && !hasAir) throw new Error(`GamePlanet: layered terrain is not configured for ${id}`);
  if (terrainId === 'hills') return { planet: original, terrainId, atmosphere: hasAir, ocean: false, seaLevel: hasAir ? 1800 : 0,
    rockHeight: original.terrain.maxHeightMeters * 0.5625, snowHeight: original.terrain.maxHeightMeters * 0.75, launchSite: null };
  const terrainConfig = { kind: 'layered' as const, options: { ...DEFAULT_LAYERED, radiusMeters: original.terrain.radiusMeters } };
  const terrain = terrainFromConfig(terrainConfig);
  // This scenery lab location is on dry lowland. Do not launch at the old underwater hills site.
  const latitude = 0.3, longitude = 0.5;
  const launchSite = { x: Math.cos(latitude) * Math.cos(longitude), y: Math.cos(latitude) * Math.sin(longitude), z: Math.sin(latitude) };
  if (terrain.sample(launchSite).heightMeters <= SEA_LEVEL) throw new Error('GamePlanet: layered launch site is underwater');
  return { planet: { ...original, label: `${original.label} · SCENERY TERRAIN`, terrainConfig, terrain }, terrainId,
    atmosphere: true, ocean: true, seaLevel: SEA_LEVEL, rockHeight: SEA_LEVEL + 2600, snowHeight: SEA_LEVEL + 4800, launchSite };
}
