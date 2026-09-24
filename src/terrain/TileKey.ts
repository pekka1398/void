import { CubeFace, directionToFaceUv, faceUvToDirection } from './CubeSphere';

export interface TerrainTileKey {
  readonly face: CubeFace;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

export type TileEdge = 'left' | 'right' | 'bottom' | 'top';

export interface TileBounds {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

export function makeTileKey(
  face: CubeFace,
  level = 0,
  x = 0,
  y = 0,
): TerrainTileKey {
  if (!Number.isInteger(level) || level < 0 || level > 24) {
    throw new RangeError(`Terrain level must be an integer in [0, 24], got ${level}`);
  }

  const width = 2 ** level;

  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= width) {
    throw new RangeError(`Invalid terrain coordinates (${x}, ${y}) at level ${level}`);
  }

  return { face, level, x, y };
}

export function tileKeyToString(key: TerrainTileKey): string {
  return `${key.face}:${key.level}:${key.x}:${key.y}`;
}

export function parseTileKey(value: string): TerrainTileKey {
  const components = value.split(':').map(Number);

  if (components.length !== 4 || components.some((component) => !Number.isFinite(component))) {
    throw new RangeError(`Invalid terrain key: ${value}`);
  }

  return makeTileKey(components[0] as CubeFace, components[1], components[2], components[3]);
}

export function tileBounds(key: TerrainTileKey): TileBounds {
  const tileWidth = 2 / 2 ** key.level;
  return {
    minU: -1 + key.x * tileWidth,
    maxU: -1 + (key.x + 1) * tileWidth,
    minV: -1 + key.y * tileWidth,
    maxV: -1 + (key.y + 1) * tileWidth,
  };
}

export function childTileKeys(key: TerrainTileKey): TerrainTileKey[] {
  const level = key.level + 1;
  const x = key.x * 2;
  const y = key.y * 2;
  return [
    makeTileKey(key.face, level, x, y),
    makeTileKey(key.face, level, x + 1, y),
    makeTileKey(key.face, level, x, y + 1),
    makeTileKey(key.face, level, x + 1, y + 1),
  ];
}

export function parentTileKey(key: TerrainTileKey): TerrainTileKey | null {
  if (key.level === 0) return null;
  return makeTileKey(key.face, key.level - 1, Math.floor(key.x / 2), Math.floor(key.y / 2));
}

/** Returns the same-resolution adjacent tile, including correctly rotated face edges. */
export function neighborTileKey(key: TerrainTileKey, edge: TileEdge): TerrainTileKey {
  const width = 2 ** key.level;
  const offsetX = edge === 'left' ? -1 : edge === 'right' ? 1 : 0;
  const offsetY = edge === 'bottom' ? -1 : edge === 'top' ? 1 : 0;
  const x = key.x + offsetX;
  const y = key.y + offsetY;

  if (x >= 0 && y >= 0 && x < width && y < width) {
    return makeTileKey(key.face, key.level, x, y);
  }

  const bounds = tileBounds(key);
  const tileWidth = 2 / width;
  const epsilon = tileWidth * 0.001;
  const u =
    edge === 'left'
      ? bounds.minU - epsilon
      : edge === 'right'
        ? bounds.maxU + epsilon
        : (bounds.minU + bounds.maxU) / 2;
  const v =
    edge === 'bottom'
      ? bounds.minV - epsilon
      : edge === 'top'
        ? bounds.maxV + epsilon
        : (bounds.minV + bounds.maxV) / 2;
  const destination = directionToFaceUv(faceUvToDirection(key.face, u, v));
  const destinationX = Math.min(width - 1, Math.max(0, Math.floor(((destination.u + 1) / 2) * width)));
  const destinationY = Math.min(width - 1, Math.max(0, Math.floor(((destination.v + 1) / 2) * width)));

  return makeTileKey(destination.face, key.level, destinationX, destinationY);
}

export function tileContainsDirection(
  key: TerrainTileKey,
  direction: { x: number; y: number; z: number },
): boolean {
  const coordinates = directionToFaceUv(direction);

  if (coordinates.face !== key.face) return false;

  const bounds = tileBounds(key);
  return (
    coordinates.u >= bounds.minU &&
    coordinates.u <= bounds.maxU &&
    coordinates.v >= bounds.minV &&
    coordinates.v <= bounds.maxV
  );
}
