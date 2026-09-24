import {
  getRestorableJourney,
  isValidSave,
  type UniverseCatalog,
  type UniverseSave,
} from '../universe';
import { AURORA_ACTIVE_ASSET } from '../render/ship/AuroraAsset';

export interface LaunchPresentationCatalog extends Pick<UniverseCatalog,
  'count' | 'seed' | 'radiusLightYears' | 'heroSystem' | 'getSystem' | 'getBody'
> {}

export interface LaunchPresentation {
  readonly title: 'VOID EXPLORER';
  readonly subtitle: 'A PROCEDURAL UNIVERSE';
  readonly universeSeed: string;
  readonly systemCount: number;
  readonly discoveredSystemCount: number;
  readonly discoveredBodyCount: number;
  readonly chartRadiusLightYears: number;
  readonly hasSavedJourney: boolean;
  readonly systemId: string;
  readonly systemName: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly landedBodyName?: string;
  readonly updatedAtEpochMs: number;
  readonly shipName: string;
  readonly shipAssetUrl: string;
  readonly actionLabel: 'START EXPEDITION' | 'CONTINUE EXPEDITION';
}

/** An immutable launch summary derived solely from actual catalog descriptors and a real save. */
export function buildLaunchPresentation(
  catalog: LaunchPresentationCatalog,
  save: Readonly<UniverseSave>,
): Readonly<LaunchPresentation> {
  const matchingSave = isValidSave(save) && save.universeSeed === String(catalog.seed);
  const journey = getRestorableJourney(save, catalog);
  const hasSavedJourney = Boolean(journey);
  const savedShip = journey?.ship;
  const currentSystem = journey?.system ?? catalog.heroSystem;
  const discoveredSystemIds = matchingSave
    ? new Set(save.discoveredSystemIds.filter((id) => Boolean(catalog.getSystem(id))))
    : new Set<string>();
  const discoveredBodyIds = matchingSave
    ? new Set(save.discoveredBodyIds.filter((id) => {
      const body = catalog.getBody(id);
      return Boolean(body && 'archetype' in body);
    }))
    : new Set<string>();
  const requestedTarget = journey?.targetId;
  const target = requestedTarget
    ? catalog.getSystem(requestedTarget) ?? catalog.getBody(requestedTarget)
    : undefined;
  const surface = journey?.surfaceCheckpoint;
  const landedBodyId = surface?.kind === 'parked'
    ? surface.anchor?.bodyId ?? surface.legacyAnchor?.bodyId
    : savedShip?.landedBodyId;
  const landedBody = landedBodyId
    ? catalog.getBody(landedBodyId)
    : undefined;

  return Object.freeze({
    title: 'VOID EXPLORER',
    subtitle: 'A PROCEDURAL UNIVERSE',
    universeSeed: String(catalog.seed),
    systemCount: catalog.count,
    discoveredSystemCount: discoveredSystemIds.size,
    discoveredBodyCount: discoveredBodyIds.size,
    chartRadiusLightYears: catalog.radiusLightYears,
    hasSavedJourney,
    systemId: currentSystem.id,
    systemName: currentSystem.name,
    ...(target ? { targetId: target.id, targetName: target.name } : {}),
    ...(landedBody && 'archetype' in landedBody && landedBody.systemId === currentSystem.id
      ? { landedBodyName: landedBody.name }
      : {}),
    updatedAtEpochMs: hasSavedJourney ? save.updatedAtEpochMs : 0,
    shipName: AURORA_ACTIVE_ASSET.name,
    shipAssetUrl: AURORA_ACTIVE_ASSET.url,
    actionLabel: hasSavedJourney ? 'CONTINUE EXPEDITION' : 'START EXPEDITION',
  });
}
