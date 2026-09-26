import { FACE_ADJACENCY, type FaceEdge } from './FaceAdjacency';
import { tileCodeOf, tileId, type TileKey } from './TileKey';

/** Same-level tile across an edge, including a cube face boundary. */
export function neighborKey(key: TileKey, edge: FaceEdge): TileKey {
  const side = 2 ** key.level;
  const { face, level, x, y } = key;
  if (edge === 'u-' && x > 0) return { face, level, x: x - 1, y };
  if (edge === 'u+' && x < side - 1) return { face, level, x: x + 1, y };
  if (edge === 'v-' && y > 0) return { face, level, x, y: y - 1 };
  if (edge === 'v+' && y < side - 1) return { face, level, x, y: y + 1 };
  const adjacent = FACE_ADJACENCY[face][edge];
  const along = edge[0] === 'u' ? y : x;
  const mapped = adjacent.reversed ? side - 1 - along : along;
  switch (adjacent.edge) {
    case 'u-': return { face: adjacent.face, level, x: 0, y: mapped };
    case 'u+': return { face: adjacent.face, level, x: side - 1, y: mapped };
    case 'v-': return { face: adjacent.face, level, x: mapped, y: 0 };
    case 'v+': return { face: adjacent.face, level, x: mapped, y: side - 1 };
  }
}

export function parentKey(key: TileKey): TileKey {
  if (key.level === 0) throw new Error(`TileNeighbors.ts parentKey: root has no parent; key=${tileId(key)}`);
  return { face: key.face, level: key.level - 1, x: Math.floor(key.x / 2), y: Math.floor(key.y / 2) };
}

/**
 * Returns a selected same-level or coarser neighbor from a map keyed by
 * `tileCode`. A finer neighbor checks the reverse relation. Only the
 * same-level neighbor key is allocated (it handles the cube-face crossing);
 * the walk to coarser levels halves x and y in place, since a coarser tile
 * across an edge is always on the same face as the same-level neighbor.
 */
export function selectedNeighbor<T extends { readonly key: TileKey }>(selected: ReadonlyMap<number, T>, key: TileKey, edge: FaceEdge): T | undefined {
  const neighbor = neighborKey(key, edge);
  const face = neighbor.face;
  let { level, x, y } = neighbor;
  while (true) {
    const found = selected.get(tileCodeOf(face, level, x, y));
    if (found) return found;
    if (level === 0) return undefined;
    level--;
    x >>= 1;
    y >>= 1;
  }
}

export function sameEdgeOnNeighbor(key: TileKey, edge: FaceEdge): FaceEdge {
  const side = 2 ** key.level;
  if (edge === 'u-' && key.x > 0) return 'u+';
  if (edge === 'u+' && key.x < side - 1) return 'u-';
  if (edge === 'v-' && key.y > 0) return 'v+';
  if (edge === 'v+' && key.y < side - 1) return 'v-';
  return FACE_ADJACENCY[key.face][edge].edge;
}

export function edgeReversedOnNeighbor(key: TileKey, edge: FaceEdge): boolean {
  const side = 2 ** key.level;
  const crossFace = (edge === 'u-' && key.x === 0) || (edge === 'u+' && key.x === side - 1) ||
    (edge === 'v-' && key.y === 0) || (edge === 'v+' && key.y === side - 1);
  return crossFace && FACE_ADJACENCY[key.face][edge].reversed;
}
