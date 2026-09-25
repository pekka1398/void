import { cubeToSphere, FACE_FRAMES } from './CubeSphere';
import { CUBE_FACES, type CubeFace } from './TileKey';
import type { Vec3 } from './Vec3';

export type FaceEdge = 'u-' | 'u+' | 'v-' | 'v+';
export const FACE_EDGES: readonly FaceEdge[] = ['u-', 'u+', 'v-', 'v+'];
export interface FaceNeighbor {
  readonly face: CubeFace;
  readonly edge: FaceEdge;
  /** Whether increasing source edge coordinate decreases the neighbor coordinate. */
  readonly reversed: boolean;
}

function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function scale(a: Vec3, k: number): Vec3 { return { x: a.x * k, y: a.y * k, z: a.z * k }; }
function edgeUv(edge: FaceEdge, t: number): readonly [number, number] {
  switch (edge) {
    case 'u-': return [-1, t];
    case 'u+': return [1, t];
    case 'v-': return [t, -1];
    case 'v+': return [t, 1];
  }
}
function cubePoint(face: CubeFace, u: number, v: number): Vec3 {
  const frame = FACE_FRAMES[face];
  return add(frame.n, add(scale(frame.a, u), scale(frame.b, v)));
}
function project(face: CubeFace, point: Vec3): readonly [number, number] {
  const frame = FACE_FRAMES[face];
  const denominator = dot(point, frame.n);
  if (denominator !== 1) throw new Error(`FaceAdjacency.ts project: point is not on face=${face}; point=${JSON.stringify(point)}; denominator=${denominator}`);
  return [dot(point, frame.a), dot(point, frame.b)];
}
function edgeOf(u: number, v: number): FaceEdge {
  if (u === -1) return 'u-';
  if (u === 1) return 'u+';
  if (v === -1) return 'v-';
  if (v === 1) return 'v+';
  throw new Error(`FaceAdjacency.ts edgeOf: projected point is not on an edge; u=${u}; v=${v}`);
}
function edgeCoordinate(edge: FaceEdge, u: number, v: number): number {
  return edge[0] === 'u' ? v : u;
}
function derive(face: CubeFace, edge: FaceEdge): FaceNeighbor {
  const [u, v] = edgeUv(edge, 0);
  const point = cubePoint(face, u, v);
  const candidates = CUBE_FACES.filter((other) => other !== face && dot(point, FACE_FRAMES[other].n) === 1);
  if (candidates.length !== 1) throw new Error(`FaceAdjacency.ts derive: expected one neighbor; face=${face}; edge=${edge}; point=${JSON.stringify(point)}; candidates=${candidates}`);
  const neighbor = candidates[0];
  const [midU, midV] = project(neighbor, point);
  const neighborEdge = edgeOf(midU, midV);
  const [endU, endV] = edgeUv(edge, 1);
  const [outU, outV] = project(neighbor, cubePoint(face, endU, endV));
  const endCoordinate = edgeCoordinate(neighborEdge, outU, outV);
  if (Math.abs(endCoordinate) !== 1) throw new Error(`FaceAdjacency.ts derive: invalid orientation; face=${face}; edge=${edge}; neighbor=${neighbor}; projected=${outU},${outV}`);
  return { face: neighbor, edge: neighborEdge, reversed: endCoordinate === -1 };
}

/** Generated from FACE_FRAMES; row order matches CubeFace and FACE_EDGES. */
export const FACE_ADJACENCY: Readonly<Record<CubeFace, Readonly<Record<FaceEdge, FaceNeighbor>>>> = Object.fromEntries(
  CUBE_FACES.map((face) => [face, Object.fromEntries(FACE_EDGES.map((edge) => [edge, derive(face, edge)]))]),
) as Record<CubeFace, Record<FaceEdge, FaceNeighbor>>;

/** Check reciprocity and sampled edge coordinates, including corners. */
export function assertFaceAdjacency(): void {
  for (const face of CUBE_FACES) for (const edge of FACE_EDGES) {
    const neighbor = FACE_ADJACENCY[face][edge];
    const back = FACE_ADJACENCY[neighbor.face][neighbor.edge];
    if (back.face !== face || back.edge !== edge || back.reversed !== neighbor.reversed) {
      throw new Error(`FaceAdjacency.ts: round trip failed; face=${face}; edge=${edge}; neighbor=${JSON.stringify(neighbor)}; back=${JSON.stringify(back)}`);
    }
    for (const t of [-1, -0.75, -0.5, 0, 0.5, 0.75, 1]) {
      const [u, v] = edgeUv(edge, t);
      const [otherU, otherV] = edgeUv(neighbor.edge, neighbor.reversed ? -t : t);
      const a = cubeToSphere(face, u, v);
      const b = cubeToSphere(neighbor.face, otherU, otherV);
      const error = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (error > 1e-14) throw new Error(`FaceAdjacency.ts: edge directions disagree; face=${face}; edge=${edge}; t=${t}; neighbor=${JSON.stringify(neighbor)}; error=${error}; a=${JSON.stringify(a)}; b=${JSON.stringify(b)}`);
    }
  }
}

assertFaceAdjacency();
