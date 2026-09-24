import { deserializeAddress, distanceVec3, dotVec3, lengthVec3, normalizeVec3, subtractAddresses } from "../../core";
import { createPlanetField, samplePlanetField } from "../../fields";
import type { UniverseCatalog } from "../UniverseCatalog";
import type { PlanetDescriptor, StarSystem } from "../types";
import {
  copySavedLandingAnchor,
  copySavedShipState,
  isFiniteSavedVector,
  isSafeSavedLandingAnchor,
  isSafeSavedShipState,
  isValidSave,
  normalizeSavedSurfaceCheckpoint,
  type SavedLandingAnchor,
  type SavedParkedShipAnchor,
  type SavedShipState,
  type SavedSurfaceActorState,
  type SavedSurfaceCheckpoint,
  type UniverseSave,
} from "./SaveSchema";

export type RestoreEligibilityCatalog = Pick<UniverseCatalog, "seed" | "getSystem" | "getBody">;

export interface RestorableJourney {
  ship: SavedShipState;
  system: StarSystem;
  targetId?: string;
  surfaceCheckpoint: SavedSurfaceCheckpoint;
}

function landableBody(
  catalog: RestoreEligibilityCatalog,
  bodyId: string,
  systemId: string,
): PlanetDescriptor | undefined {
  const body = catalog.getBody(bodyId);
  return body && "isLandable" in body && body.isLandable && body.systemId === systemId ? body : undefined;
}

export function isRestorableLandingAnchor(
  value: unknown,
  catalog: RestoreEligibilityCatalog,
  systemId: string,
): value is SavedLandingAnchor {
  return isSafeSavedLandingAnchor(value) && Boolean(landableBody(catalog, value.bodyId, systemId));
}

function parkedAnchorFitsBody(anchor: SavedParkedShipAnchor, body: PlanetDescriptor): boolean {
  const radial = lengthVec3(anchor.bodyFixedOriginMeters);
  const ground = samplePlanetField(createPlanetField(body), normalizeVec3(anchor.bodyFixedOriginMeters));
  if (Math.abs(radial - body.radiusMeters - ground.heightMeters) > 128) return false;
  // A corrupted contact on the other side of the world must not become a
  // supposedly valid physical landing kit. Exact pad safety is checked again
  // by the contact authority when the real terrain generation is ready.
  return anchor.padContacts.every((pad) => distanceVec3(pad.bodyFixedPointMeters, anchor.bodyFixedOriginMeters) <= 64);
}

/** Cheap boot checks only; the live contact/capsule check remains mandatory. */
export function isRestorableSurfaceActor(
  actor: SavedSurfaceActorState,
  anchor: SavedParkedShipAnchor,
  catalog: RestoreEligibilityCatalog,
  systemId: string,
): boolean {
  const body = landableBody(catalog, anchor.bodyId, systemId);
  if (!body || actor.bodyId !== body.id || actor.systemId !== systemId) return false;
  const radial = lengthVec3(actor.bodyFixedCenterMeters);
  const direction = normalizeVec3(actor.bodyFixedCenterMeters);
  const sample = samplePlanetField(createPlanetField(body), direction);
  const clearance = radial - body.radiusMeters - sample.heightMeters;
  return !sample.ocean && clearance >= -4 && clearance <= 32 &&
    lengthVec3(actor.bodyFixedVelocityMetersPerSecond) <= 150 &&
    Math.abs(dotVec3(direction, normalizeVec3(actor.tangentForwardBodyFixed))) <= 0.2;
}

/**
 * One non-mutating decision for the title screen and the real restore path.
 * A bad surface actor is recoverable independently of the valid expedition.
 */
export function getRestorableJourney(
  save: Readonly<UniverseSave>,
  catalog: RestoreEligibilityCatalog,
): RestorableJourney | undefined {
  if (!isValidSave(save) || save.universeSeed !== String(catalog.seed) ||
    !Number.isFinite(save.updatedAtEpochMs) || save.updatedAtEpochMs <= 0 ||
    !isSafeSavedShipState(save.ship)) return undefined;
  const system = catalog.getSystem(save.ship.activeSystemId);
  if (!system) return undefined;
  if (!isFiniteSavedVector(subtractAddresses(deserializeAddress(save.ship.position), system.position))) return undefined;
  const ship = copySavedShipState(save.ship);
  const legacyAnchor = isRestorableLandingAnchor(ship.landedAnchor, catalog, system.id)
    ? copySavedLandingAnchor(ship.landedAnchor)
    : undefined;
  if (!legacyAnchor) delete ship.landedAnchor;
  let surfaceCheckpoint = normalizeSavedSurfaceCheckpoint(save.surface, ship);
  if (surfaceCheckpoint.kind === "parked") {
    if (surfaceCheckpoint.anchor) {
      const anchor = surfaceCheckpoint.anchor;
      const body = landableBody(catalog, anchor.bodyId, system.id);
      if (!body || !parkedAnchorFitsBody(anchor, body)) {
        surfaceCheckpoint = legacyAnchor
          ? { kind: "parked", occupancy: "inside", legacyAnchor }
          : { kind: "airborne", occupancy: "inside" };
      } else if (surfaceCheckpoint.occupancy === "outside" &&
        !isRestorableSurfaceActor(surfaceCheckpoint.actor, anchor, catalog, system.id)) {
        surfaceCheckpoint = { kind: "parked", occupancy: "inside", anchor };
      }
    } else if (!isRestorableLandingAnchor(surfaceCheckpoint.legacyAnchor, catalog, system.id)) {
      surfaceCheckpoint = { kind: "airborne", occupancy: "inside" };
    }
  }

  const waypoint = save.waypoints.find((entry) => entry.id === "active-destination");
  const requestedTarget = ship.targetId ?? waypoint?.targetId;
  const targetId = requestedTarget && (catalog.getSystem(requestedTarget) || catalog.getBody(requestedTarget))
    ? requestedTarget
    : undefined;
  return { ship: copySavedShipState(ship, surfaceCheckpoint), system, surfaceCheckpoint, ...(targetId ? { targetId } : {}) };
}
