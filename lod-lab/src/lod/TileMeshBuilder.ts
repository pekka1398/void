import type { Vec3 } from './Vec3';
import { cubeToSphere } from './CubeSphere';
import { tileId, tileUvBounds, type TileKey } from './TileKey';

/** Rendered surface above the reference radius, plus its display color (linear 0–1). */
export interface SurfaceSample {
  readonly heightMeters: number;
  readonly color: readonly [number, number, number];
}

export type SurfaceSampler = (bodyFixedDirection: Vec3) => SurfaceSample;

export interface TileMeshData {
  readonly id: string;
  readonly key: TileKey;
  /** Body-fixed float64 origin; every vertex position is float32 relative to it. */
  readonly origin: Vec3;
  /** N*N grid vertices followed by 4*N skirt vertices (bottom, top, left, right edge). */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  /** (i, j, skirt): integer grid coordinate, skirts repeat their edge vertex's (i, j) with skirt = 1. */
  readonly grid: Float32Array;
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
  /**
   * Largest 3D deviation between this tile's grid and its own half-resolution
   * interpolation. A data-driven proxy for geometric error: flat ocean ≈ sphere
   * sag only, rough mountains high. Selection compares it in screen pixels.
   */
  readonly errorMeters: number;
  readonly skirtDepthMeters: number;
  readonly buildMilliseconds: number;
}

export interface TileMeshOptions {
  readonly radiusMeters: number;
  /** Vertices per tile side; N - 1 must be even for the error estimate. */
  readonly resolution: number;
}

/**
 * Pure tile generation. Samples an (N+2)² grid with a one-vertex apron so
 * border normals are computed from real neighbors, identical on both sides of
 * any tile edge regardless of which tile (or face) built it.
 */
export function buildTileMesh(key: TileKey, sampler: SurfaceSampler, options: TileMeshOptions): TileMeshData {
  const started = performance.now();
  const n = options.resolution;
  const radius = options.radiusMeters;
  const e = n + 2;
  const { u0, v0, u1, v1 } = tileUvBounds(key);
  const du = (u1 - u0) / (n - 1);
  const dv = (v1 - v0) / (n - 1);

  const origin = cubeToSphere(key.face, (u0 + u1) / 2, (v0 + v1) / 2);
  origin.x *= radius;
  origin.y *= radius;
  origin.z *= radius;

  // Extended grid in float64, relative to origin to keep later float32 conversion exact enough.
  const ex = new Float64Array(e * e * 3);
  const dirs = new Float64Array(n * n * 3);
  const heights = new Float64Array(n * n);
  const colors = new Float32Array((n * n + 4 * n) * 3);
  const dir = { x: 0, y: 0, z: 0 };
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;

  for (let j = 0; j < e; j++) {
    for (let i = 0; i < e; i++) {
      cubeToSphere(key.face, u0 + (i - 1) * du, v0 + (j - 1) * dv, dir);
      const sample = sampler(dir);
      const r = radius + sample.heightMeters;
      const k = (j * e + i) * 3;
      ex[k] = dir.x * r - origin.x;
      ex[k + 1] = dir.y * r - origin.y;
      ex[k + 2] = dir.z * r - origin.z;
      const gi = i - 1;
      const gj = j - 1;
      if (gi >= 0 && gi < n && gj >= 0 && gj < n) {
        const g = gj * n + gi;
        dirs[g * 3] = dir.x;
        dirs[g * 3 + 1] = dir.y;
        dirs[g * 3 + 2] = dir.z;
        heights[g] = sample.heightMeters;
        colors[g * 3] = sample.color[0];
        colors[g * 3 + 1] = sample.color[1];
        colors[g * 3 + 2] = sample.color[2];
        minHeight = Math.min(minHeight, sample.heightMeters);
        maxHeight = Math.max(maxHeight, sample.heightMeters);
      }
    }
  }

  const vertexCount = n * n + 4 * n;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const grid = new Float32Array(vertexCount * 3);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const g = j * n + i;
      const c = ((j + 1) * e + (i + 1)) * 3;
      positions[g * 3] = ex[c];
      positions[g * 3 + 1] = ex[c + 1];
      positions[g * 3 + 2] = ex[c + 2];
      const l = c - 3;
      const r = c + 3;
      const d = c - e * 3;
      const t = c + e * 3;
      const tux = ex[r] - ex[l];
      const tuy = ex[r + 1] - ex[l + 1];
      const tuz = ex[r + 2] - ex[l + 2];
      const tvx = ex[t] - ex[d];
      const tvy = ex[t + 1] - ex[d + 1];
      const tvz = ex[t + 2] - ex[d + 2];
      let nx = tuy * tvz - tuz * tvy;
      let ny = tuz * tvx - tux * tvz;
      let nz = tux * tvy - tuy * tvx;
      const normalLength = Math.hypot(nx, ny, nz);
      if (!Number.isFinite(normalLength) || normalLength < 1e-12) {
        throw new Error(`Degenerate tile normal at ${tileId(key)} (${i}, ${j})`);
      }
      const inv = 1 / normalLength;
      nx *= inv;
      ny *= inv;
      nz *= inv;
      normals[g * 3] = nx;
      normals[g * 3 + 1] = ny;
      normals[g * 3 + 2] = nz;
      grid[g * 3] = i;
      grid[g * 3 + 1] = j;
    }
  }

  const errorMeters = measureHalfResolutionError(positions, n);
  // Deep enough to cover the largest crack a coarser neighbor can open along this edge.
  const spacing = radius * (Math.PI / 2) / 2 ** key.level / (n - 1);
  const skirtDepthMeters = Math.max(errorMeters * 2, spacing * 0.25, 1);

  const edgeVertex = [
    (s: number) => s, // bottom: j = 0
    (s: number) => (n - 1) * n + s, // top: j = n - 1
    (s: number) => s * n, // left: i = 0
    (s: number) => s * n + n - 1, // right: i = n - 1
  ];
  for (let edge = 0; edge < 4; edge++) {
    for (let s = 0; s < n; s++) {
      const g = edgeVertex[edge](s);
      const k = n * n + edge * n + s;
      const r = radius + heights[g] - skirtDepthMeters;
      positions[k * 3] = dirs[g * 3] * r - origin.x;
      positions[k * 3 + 1] = dirs[g * 3 + 1] * r - origin.y;
      positions[k * 3 + 2] = dirs[g * 3 + 2] * r - origin.z;
      normals[k * 3] = normals[g * 3];
      normals[k * 3 + 1] = normals[g * 3 + 1];
      normals[k * 3 + 2] = normals[g * 3 + 2];
      colors[k * 3] = colors[g * 3];
      colors[k * 3 + 1] = colors[g * 3 + 1];
      colors[k * 3 + 2] = colors[g * 3 + 2];
      grid[k * 3] = grid[g * 3];
      grid[k * 3 + 1] = grid[g * 3 + 1];
      grid[k * 3 + 2] = 1;
    }
  }

  return {
    id: tileId(key),
    key,
    origin,
    positions,
    normals,
    colors,
    grid,
    minHeightMeters: minHeight,
    maxHeightMeters: maxHeight,
    errorMeters,
    skirtDepthMeters,
    buildMilliseconds: performance.now() - started,
  };
}

function measureHalfResolutionError(positions: Float32Array, n: number): number {
  let worst = 0;
  const at = (i: number, j: number, axis: number) => positions[(j * n + i) * 3 + axis];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const oddI = i & 1;
      const oddJ = j & 1;
      if (!oddI && !oddJ) continue;
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (let axis = 0; axis < 3; axis++) {
        let interpolated: number;
        if (oddI && oddJ) {
          interpolated = (at(i - 1, j - 1, axis) + at(i + 1, j - 1, axis) +
            at(i - 1, j + 1, axis) + at(i + 1, j + 1, axis)) / 4;
        } else if (oddI) {
          interpolated = (at(i - 1, j, axis) + at(i + 1, j, axis)) / 2;
        } else {
          interpolated = (at(i, j - 1, axis) + at(i, j + 1, axis)) / 2;
        }
        const delta = at(i, j, axis) - interpolated;
        if (axis === 0) dx = delta;
        else if (axis === 1) dy = delta;
        else dz = delta;
      }
      worst = Math.max(worst, Math.hypot(dx, dy, dz));
    }
  }
  return worst;
}

/**
 * Shared index buffer for every tile of resolution N. The grid occupies
 * [0, gridIndexCount); skirts follow, so a draw range toggles them.
 */
export function buildTileIndices(n: number): { indices: Uint32Array; gridIndexCount: number } {
  const quads = (n - 1) * (n - 1);
  const skirtQuads = 4 * (n - 1);
  const indices = new Uint32Array((quads + skirtQuads) * 6);
  let o = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[o++] = a; indices[o++] = b; indices[o++] = d;
      indices[o++] = a; indices[o++] = d; indices[o++] = c;
    }
  }
  const gridIndexCount = o;
  // Edge order matches buildTileMesh. With a × b = n, a skirt triangle
  // (e_s, e_s+1, skirt_s) faces outward on top/left edges and inward on
  // bottom/right, so those two are reversed.
  const edgeVertex = [
    (s: number) => s,
    (s: number) => (n - 1) * n + s,
    (s: number) => s * n,
    (s: number) => s * n + n - 1,
  ];
  const reversed = [true, false, false, true];
  for (let edge = 0; edge < 4; edge++) {
    for (let s = 0; s < n - 1; s++) {
      const e0 = edgeVertex[edge](s);
      const e1 = edgeVertex[edge](s + 1);
      const s0 = n * n + edge * n + s;
      const s1 = s0 + 1;
      if (reversed[edge]) {
        indices[o++] = e0; indices[o++] = s0; indices[o++] = e1;
        indices[o++] = e1; indices[o++] = s0; indices[o++] = s1;
      } else {
        indices[o++] = e0; indices[o++] = e1; indices[o++] = s0;
        indices[o++] = e1; indices[o++] = s1; indices[o++] = s0;
      }
    }
  }
  return { indices, gridIndexCount };
}
