/** Cube face index: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. */
export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;

export const CUBE_FACES: readonly CubeFace[] = [0, 1, 2, 3, 4, 5];

/** One quadtree node on one cube face; x/y count tiles along the face's u/v axes. */
export interface TileKey {
  readonly face: CubeFace;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

export interface TileUvBounds {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export function tileId(key: TileKey): string {
  return `${key.face}/${key.level}/${key.x}/${key.y}`;
}

export function rootKey(face: CubeFace): TileKey {
  return { face, level: 0, x: 0, y: 0 };
}

/** Children in (x, y) order: (0,0) (1,0) (0,1) (1,1). */
export function childKeys(key: TileKey): [TileKey, TileKey, TileKey, TileKey] {
  const level = key.level + 1;
  const x = key.x * 2;
  const y = key.y * 2;
  return [
    { face: key.face, level, x, y },
    { face: key.face, level, x: x + 1, y },
    { face: key.face, level, x, y: y + 1 },
    { face: key.face, level, x: x + 1, y: y + 1 },
  ];
}

/** Face-parameter bounds in [-1, 1]. */
export function tileUvBounds(key: TileKey): TileUvBounds {
  const size = 2 / 2 ** key.level;
  const u0 = -1 + key.x * size;
  const v0 = -1 + key.y * size;
  return { u0, v0, u1: u0 + size, v1: v0 + size };
}
