import { Vector3 } from 'three';

import { CUBE_FACES, faceUvToDirection } from './CubeSphere';
import {
  childTileKeys,
  makeTileKey,
  neighborTileKey,
  parseTileKey,
  parentTileKey,
  tileBounds,
  tileKeyToString,
  type TerrainTileKey,
  type TileEdge,
} from './TileKey';

export interface TerrainSelectionOptions {
  radius: number;
  maxDepth?: number;
  maxTiles?: number;
  pixelError?: number;
  viewportHeight?: number;
  minDepth?: number;
  /** Body-local render units per second; no canonical coordinates are altered. */
  velocity?: { x: number; y: number; z: number };
  predictionSeconds?: number;
  fieldOfViewDegrees?: number;
  /** Actual camera-forward vector in the same body-local frame as cameraPosition. */
  lookDirection?: { x: number; y: number; z: number };
  /** Physical viewport aspect; widens the genuine left/right horizon acquisition. */
  viewportAspect?: number;
  /** Preserve nearby ready leaves while prioritizing the actual approaching direction. */
  previousSelection?: ReadonlySet<string>;
}

export interface SelectedTerrainTile {
  key: TerrainTileKey;
  priority: number;
  screenError: number;
  distance: number;
}

export interface TerrainViewDirections {
  radial: Vector3;
  predicted: Vector3;
  forward: Vector3;
  horizon: Vector3;
  leftHorizon: Vector3;
  rightHorizon: Vector3;
  horizonAngleRadians: number;
  hasLookDirection: boolean;
}

const TILE_EDGES: readonly TileEdge[] = ['left', 'right', 'bottom', 'top'];

function tileMetrics(
  key: TerrainTileKey,
  camera: Vector3,
  radius: number,
  viewportHeight: number,
  projectionScale: number,
  viewDirections: TerrainViewDirections,
  lookDirection?: Vector3,
  horizontalFieldOfViewCosine = -1,
  previouslyRefined?: ReadonlySet<string>,
): SelectedTerrainTile {
  const bounds = tileBounds(key);
  const direction = faceUvToDirection(
    key.face,
    (bounds.minU + bounds.maxU) / 2,
    (bounds.minV + bounds.maxV) / 2,
  );
  const alignment = Math.max(0, direction.dot(viewDirections.predicted));
  const center = direction.clone().multiplyScalar(radius);
  const distance = Math.max(radius * 0.000_000_01, center.distanceTo(camera));
  const angularWidth = Math.PI / (2 * 2 ** key.level);
  const physicalWidth = radius * angularWidth;
  const screenError = (physicalWidth / distance) * viewportHeight * projectionScale;
  const motionFocus = 1 + Math.pow(alignment, 8) * 0.76;
  const angularRadius = angularWidth * 0.8;
  const forwardDistance = Math.acos(Math.min(1, Math.max(-1, direction.dot(viewDirections.forward))));
  const horizonDistance = Math.min(
    Math.acos(Math.min(1, Math.max(-1, direction.dot(viewDirections.horizon)))),
    Math.acos(Math.min(1, Math.max(-1, direction.dot(viewDirections.leftHorizon)))),
    Math.acos(Math.min(1, Math.max(-1, direction.dot(viewDirections.rightHorizon)))),
  );
  const horizonEdgeDistance = Math.min(
    Math.acos(Math.min(1, Math.max(-1, direction.dot(viewDirections.leftHorizon)))),
    Math.acos(Math.min(1, Math.max(-1, direction.dot(viewDirections.rightHorizon)))),
  );
  const forwardFocus = viewDirections.hasLookDirection
    ? 1 + Math.max(0, 1 - forwardDistance / Math.max(0.038, angularRadius * 2.55)) * 1.08
    : 1;
  const horizonFocus = viewDirections.hasLookDirection
    ? 1 + Math.max(0, 1 - horizonDistance / Math.max(0.042, angularRadius * 2.4)) * 0.57 +
      Math.max(0, 1 - horizonEdgeDistance / Math.max(0.038, angularRadius * 1.85)) * 0.16
    : 1;
  const cameraRay = lookDirection ? center.clone().sub(camera).normalize() : undefined;
  const frustumFocus = cameraRay && lookDirection
    ? cameraRay.dot(lookDirection) >= horizontalFieldOfViewCosine ? 1.31 : 0.83
    : 1;
  // Retain previously refined branches, not their leaves. Giving a leaf a
  // split-priority bonus made a stationary camera alternate between two LOD
  // layouts and cancel the same genuine worker jobs on every frame.
  const retained = previouslyRefined?.has(tileKeyToString(key)) ? 1.14 : 1;

  return {
    key,
    priority: screenError * motionFocus * forwardFocus * horizonFocus * frustumFocus * retained + key.level * 0.01,
    screenError,
    distance,
  };
}

/** Sample only authentic body-fixed surface, visible horizon, and predicted travel directions. */
export function resolveTerrainViewDirections(
  cameraPosition: { x: number; y: number; z: number },
  options: Pick<
    TerrainSelectionOptions,
    'radius' | 'velocity' | 'predictionSeconds' | 'lookDirection' | 'fieldOfViewDegrees' | 'viewportAspect'
  >,
): TerrainViewDirections {
  const camera = new Vector3(cameraPosition.x, cameraPosition.y, cameraPosition.z);
  const radius = Math.max(Number.EPSILON, options.radius);
  const radial = camera.lengthSq() > Number.EPSILON
    ? camera.clone().normalize()
    : new Vector3(0, 0, 1);
  const leadSeconds = Math.max(0, Math.min(2.4, options.predictionSeconds ?? 0.72));
  const projected = options.velocity
    ? camera.clone().addScaledVector(
      new Vector3(options.velocity.x, options.velocity.y, options.velocity.z),
      leadSeconds,
    )
    : camera.clone();
  const predicted = projected.lengthSq() > Number.EPSILON ? projected.normalize() : radial.clone();
  const look = options.lookDirection
    ? new Vector3(options.lookDirection.x, options.lookDirection.y, options.lookDirection.z)
    : undefined;
  const hasLookDirection = Boolean(look && look.lengthSq() > Number.EPSILON);
  if (look && hasLookDirection) look.normalize();

  const tangent = hasLookDirection && look
    ? look.clone().addScaledVector(radial, -look.dot(radial))
    : predicted.clone().addScaledVector(radial, -predicted.dot(radial));
  if (tangent.lengthSq() < 0.000_000_01) {
    tangent.crossVectors(Math.abs(radial.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0), radial);
  }
  tangent.normalize();

  const horizonAngle = Math.acos(Math.min(1, radius / Math.max(radius, camera.length())));
  const reachableAngle = Math.max(0.012, Math.min(1.22, horizonAngle * 0.89));
  const horizon = radial.clone().multiplyScalar(Math.cos(reachableAngle))
    .addScaledVector(tangent, Math.sin(reachableAngle)).normalize();
  let forward = horizon.clone();
  if (look && hasLookDirection) {
    const halfB = camera.dot(look);
    const c = camera.lengthSq() - radius * radius;
    const discriminant = halfB * halfB - c;
    if (discriminant >= 0 && halfB < 0) {
      const hit = -halfB - Math.sqrt(discriminant);
      if (hit >= 0) forward = camera.clone().addScaledVector(look, hit).normalize();
    }
  } else {
    forward = predicted.clone();
  }

  const side = new Vector3().crossVectors(radial, tangent).normalize();
  const verticalFov = Math.min(100, Math.max(25, options.fieldOfViewDegrees ?? 57)) * Math.PI / 180;
  const aspect = Math.max(0.45, Math.min(2.5, options.viewportAspect ?? 16 / 9));
  const edgeSpread = Math.min(0.9, Math.tan(verticalFov * 0.5) * aspect * 0.72);
  const leftTangent = tangent.clone().addScaledVector(side, -edgeSpread).normalize();
  const rightTangent = tangent.clone().addScaledVector(side, edgeSpread).normalize();
  const leftHorizon = radial.clone().multiplyScalar(Math.cos(reachableAngle))
    .addScaledVector(leftTangent, Math.sin(reachableAngle)).normalize();
  const rightHorizon = radial.clone().multiplyScalar(Math.cos(reachableAngle))
    .addScaledVector(rightTangent, Math.sin(reachableAngle)).normalize();

  return {
    radial,
    predicted,
    forward,
    horizon,
    leftHorizon,
    rightHorizon,
    horizonAngleRadians: horizonAngle,
    hasLookDirection,
  };
}

function intersectsVisibleHemisphere(
  key: TerrainTileKey,
  camera: Vector3,
  radius: number,
): boolean {
  const distance = camera.length();

  if (distance <= radius * 1.015) return true;

  const bounds = tileBounds(key);
  const direction = faceUvToDirection(
    key.face,
    (bounds.minU + bounds.maxU) / 2,
    (bounds.minV + bounds.maxV) / 2,
  );
  const cameraDirection = camera.clone().normalize();
  const margin = Math.min(1, 1.8 / 2 ** key.level);
  return direction.dot(cameraDirection) > radius / distance - margin;
}

function findCoveringTile(
  requested: TerrainTileKey,
  active: Map<string, SelectedTerrainTile>,
): SelectedTerrainTile | undefined {
  let current: TerrainTileKey | null = requested;

  while (current !== null) {
    const found = active.get(tileKeyToString(current));
    if (found) return found;
    current = parentTileKey(current);
  }

  return undefined;
}

function previouslyRefinedTiles(selection?: ReadonlySet<string>): ReadonlySet<string> {
  const refined = new Set<string>();
  for (const id of selection ?? []) {
    let key: TerrainTileKey | null;
    try { key = parentTileKey(parseTileKey(id)); } catch { continue; }
    while (key) {
      refined.add(tileKeyToString(key));
      key = parentTileKey(key);
    }
  }
  return refined;
}

/** Plan the complete 2:1 neighbor closure before spending any leaf budget. */
function refineBalanced(
  candidate: SelectedTerrainTile,
  selected: ReadonlyMap<string, SelectedTerrainTile>,
  metricsFor: (key: TerrainTileKey) => SelectedTerrainTile,
  maxTiles: number,
  maxDepth: number,
): Map<string, SelectedTerrainTile> | undefined {
  const next = new Map(selected);
  const pending = [candidate.key];

  while (pending.length > 0) {
    const key = pending.pop()!;
    const id = tileKeyToString(key);
    if (!next.has(id)) continue;
    if (key.level >= maxDepth || next.size + 3 > maxTiles) return undefined;

    next.delete(id);
    const children = childTileKeys(key);
    for (const child of children) next.set(tileKeyToString(child), metricsFor(child));

    for (const child of children) {
      for (const edge of TILE_EDGES) {
        const neighbor = findCoveringTile(neighborTileKey(child, edge), next);
        if (neighbor && child.level - neighbor.key.level > 1) pending.push(neighbor.key);
      }
    }
  }

  return next;
}

/**
 * Select a bounded adaptive neighborhood. Parents split only as a complete set;
 * neighbor balancing prevents visible 4:1-or-larger transitions.
 */
export function selectTerrainTiles(
  cameraPosition: { x: number; y: number; z: number },
  options: TerrainSelectionOptions,
): SelectedTerrainTile[] {
  const camera = new Vector3(cameraPosition.x, cameraPosition.y, cameraPosition.z);
  const radius = Math.max(Number.EPSILON, options.radius);
  const maxDepth = Math.max(0, Math.min(20, options.maxDepth ?? 18));
  const maxTiles = Math.max(6, options.maxTiles ?? 96);
  const pixelError = Math.max(1, options.pixelError ?? 74);
  const viewportHeight = Math.max(1, options.viewportHeight ?? 540);
  const minDepth = Math.max(0, Math.min(maxDepth, options.minDepth ?? 0));
  const fieldOfView = Math.min(100, Math.max(25, options.fieldOfViewDegrees ?? 57));
  const projectionScale = 0.5 / Math.tan(fieldOfView * Math.PI / 360);
  const viewDirections = resolveTerrainViewDirections(camera, options);
  const look = options.lookDirection
    ? new Vector3(options.lookDirection.x, options.lookDirection.y, options.lookDirection.z).normalize()
    : undefined;
  const horizontalFov = Math.atan(
    Math.tan(fieldOfView * Math.PI / 360) *
    Math.max(0.45, Math.min(2.5, options.viewportAspect ?? 16 / 9)),
  );
  const frustumCosine = Math.cos(Math.min(Math.PI * 0.48, horizontalFov * 1.32));
  const previouslyRefined = previouslyRefinedTiles(options.previousSelection);
  let selected = new Map<string, SelectedTerrainTile>();
  const metricsFor = (key: TerrainTileKey): SelectedTerrainTile => tileMetrics(
    key,
    camera,
    radius,
    viewportHeight,
    projectionScale,
    viewDirections,
    look,
    frustumCosine,
    previouslyRefined,
  );

  // Six coarse roots are structural coverage, even when only the near side is
  // refined. A camera crossing a cube-face edge cannot uncover a missing face.
  for (const face of CUBE_FACES) {
    const root = makeTileKey(face);
    selected.set(tileKeyToString(root), metricsFor(root));
  }

  while (selected.size + 3 <= maxTiles) {
    const candidates = [...selected.values()]
      .filter((tile) => tile.key.level < maxDepth &&
        (tile.key.level < minDepth || tile.screenError >= pixelError) &&
        intersectsVisibleHemisphere(tile.key, camera, radius))
      .sort((first, second) => second.priority - first.priority);
    let refined: Map<string, SelectedTerrainTile> | undefined;
    for (const candidate of candidates) {
      refined = refineBalanced(candidate, selected, metricsFor, maxTiles, maxDepth);
      if (refined) break;
    }
    if (!refined) break;
    selected = refined;
  }

  return [...selected.values()].sort((first, second) => second.priority - first.priority);
}

export class PlanetQuadtree {
  private readonly options: TerrainSelectionOptions;

  constructor(options: TerrainSelectionOptions) {
    this.options = options;
  }

  select(cameraPosition: { x: number; y: number; z: number }): SelectedTerrainTile[] {
    return selectTerrainTiles(cameraPosition, this.options);
  }
}
