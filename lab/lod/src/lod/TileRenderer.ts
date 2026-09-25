import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  float,
  fract,
  fwidth,
  min,
  mix,
  uniform,
  vec3,
  vertexColor,
} from 'three/tsl';
import type { Vec3 } from './Vec3';
import type { LodNode } from './PlanetLod';
import { buildTileIndices, type TileMeshData } from './TileMeshBuilder';
import { FACE_EDGES, type FaceEdge } from './FaceAdjacency';
import { edgeReversedOnNeighbor, neighborKey, sameEdgeOnNeighbor, selectedNeighbor } from './TileNeighbors';

export type TileColorMode = 'terrain' | 'level' | 'tint';

export interface TileRendererOptions {
  readonly resolution: number;
  readonly metersPerRenderUnit: number;
}

interface TileGpu {
  readonly mesh: THREE.Mesh;
  readonly wireframe: THREE.LineSegments;
  readonly boundary: THREE.LineSegments;
  readonly data: TileMeshData;
  readonly seamSignature: string;
  readonly copyBytes: number;
}

/**
 * Three.js adapter: owns one mesh per ready tile, places it camera-relative
 * each frame (camera sits at the GPU origin), and exposes debug shading.
 * Nothing here feeds back into selection.
 */
export class TileRenderer {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, TileGpu>();
  private readonly index: THREE.BufferAttribute;
  private readonly surfaceWireIndex: THREE.BufferAttribute;
  private readonly fullWireIndex: THREE.BufferAttribute;
  private readonly boundaryIndex: THREE.BufferAttribute;
  private readonly wireMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: true });
  private readonly boundaryMaterial = new THREE.LineBasicMaterial({ color: 0xff3030, depthTest: true });
  private readonly gridIndexCount: number;
  private readonly materials: THREE.MeshStandardNodeMaterial[] = [];
  private skirts = false;
  private lastCreated = 0;
  private lastDisposed = 0;
  private copiedMeshBytes = 0;

  private readonly levelMix = uniform(0);
  private readonly gridLines = uniform(0);
  private wireframeVisible = true;
  private boundaryVisible = true;
  private readonly skirtHighlight = uniform(0);

  constructor(private readonly options: TileRendererOptions) {
    const { indices, gridIndexCount } = buildTileIndices(options.resolution);
    this.index = new THREE.BufferAttribute(indices, 1);
    this.gridIndexCount = gridIndexCount;
    this.surfaceWireIndex = new THREE.BufferAttribute(buildWireIndices(indices.subarray(0, gridIndexCount)), 1);
    this.fullWireIndex = new THREE.BufferAttribute(buildWireIndices(indices), 1);
    this.boundaryIndex = new THREE.BufferAttribute(buildBoundaryIndices(options.resolution), 1);
    this.group.name = 'lod-tiles';
  }

  get drawnTileCount(): number {
    let count = 0;
    for (const tile of this.tiles.values()) if (tile.mesh.visible) count++;
    return count;
  }
  get createdLastSync(): number { return this.lastCreated; }
  get disposedLastSync(): number { return this.lastDisposed; }
  get rendererCopyBytes(): number { return this.copiedMeshBytes; }

  setColorMode(mode: TileColorMode): void {
    this.levelMix.value = mode === 'terrain' ? 0 : mode === 'level' ? 1 : 0.45;
  }
  setGridLines(enabled: boolean): void { this.gridLines.value = enabled ? 1 : 0; }
  setMeshWireframe(enabled: boolean): void {
    this.wireframeVisible = enabled;
    for (const tile of this.tiles.values()) tile.wireframe.visible = enabled;
  }
  setTileBoundaries(enabled: boolean): void {
    this.boundaryVisible = enabled;
    for (const tile of this.tiles.values()) tile.boundary.visible = enabled;
  }
  setSkirtHighlight(enabled: boolean): void { this.skirtHighlight.value = enabled ? 1 : 0; }
  setSkirts(enabled: boolean): void {
    this.skirts = enabled;
    for (const tile of this.tiles.values()) {
      this.applyDrawRange(tile.mesh.geometry);
      tile.wireframe.geometry.setIndex(this.skirts ? this.fullWireIndex : this.surfaceWireIndex);
    }
  }

  /** Show exactly `render`, positioned relative to the body-fixed camera. */
  sync(render: readonly LodNode[], cameraPosition: Vec3): void {
    this.lastCreated = 0;
    this.lastDisposed = 0;
    const wanted = new Set<string>();
    const selected = new Map(render.map((node) => [node.id, node]));
    const scale = 1 / this.options.metersPerRenderUnit;
    for (const node of render) {
      const data = node.data;
      if (!data) throw new Error(`TileRenderer.ts sync: render selection has no mesh; id=${node.id}; level=${node.key.level}; camera=${JSON.stringify(cameraPosition)}`);
      wanted.add(node.id);
      const seams: Partial<Record<FaceEdge, LodNode>> = {};
      for (const edge of FACE_EDGES) {
        const neighbor = selectedNeighbor(selected, node.key, edge);
        if (!neighbor) continue;
        const difference = node.key.level - neighbor.key.level;
        if (difference > 1) throw new Error(`TileRenderer.ts sync: adjacent LOD gap exceeds one; tile=${node.id}; edge=${edge}; neighbor=${neighbor.id}`);
        if (difference === 1) seams[edge] = neighbor;
      }
      const seamSignature = FACE_EDGES.map((edge) => `${edge}:${seams[edge]?.id ?? '-'}`).join('|');
      let tile = this.tiles.get(node.id);
      if (tile && (tile.data !== data || tile.seamSignature !== seamSignature)) {
        this.disposeTile(node.id);
        tile = undefined;
      }
      if (!tile) tile = this.createTile(data, seams, seamSignature);
      tile.mesh.visible = true;
      // float64 subtraction on the CPU; only the small camera-relative offset reaches float32.
      tile.mesh.position.set(
        (data.origin.x - cameraPosition.x) * scale,
        (data.origin.y - cameraPosition.y) * scale,
        (data.origin.z - cameraPosition.z) * scale,
      );
      tile.wireframe.position.copy(tile.mesh.position);
      tile.boundary.position.copy(tile.mesh.position);
    }
    for (const [id, tile] of this.tiles) {
      // Tile data stays cached in PlanetLod; only the GPU copy is released.
      if (!wanted.has(id)) this.disposeTile(id);
    }
  }

  dispose(): void {
    for (const id of [...this.tiles.keys()]) this.disposeTile(id);
    for (const material of this.materials) material.dispose();
    this.wireMaterial.dispose();
    this.boundaryMaterial.dispose();
  }

  private createTile(data: TileMeshData, seams: Partial<Record<FaceEdge, LodNode>>, seamSignature: string): TileGpu {
    const geometry = new THREE.BufferGeometry();
    const { positions, normals } = stitchEdges(data, seams, this.options.resolution);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('grid', new THREE.BufferAttribute(data.grid, 3));
    geometry.setIndex(this.index);
    geometry.computeBoundingSphere();
    this.applyDrawRange(geometry);
    const mesh = new THREE.Mesh(geometry, this.materialForLevel(data.key.level));
    mesh.name = `tile ${data.id}`;
    mesh.scale.setScalar(1 / this.options.metersPerRenderUnit);
    mesh.matrixAutoUpdate = true;
    const wireGeometry = new THREE.BufferGeometry();
    wireGeometry.setAttribute('position', geometry.getAttribute('position'));
    wireGeometry.setIndex(this.skirts ? this.fullWireIndex : this.surfaceWireIndex);
    const wireframe = new THREE.LineSegments(wireGeometry, this.wireMaterial);
    wireframe.name = `mesh edges ${data.id}`;
    wireframe.renderOrder = 1;
    wireframe.scale.copy(mesh.scale);
    wireframe.visible = this.wireframeVisible;
    const boundaryGeometry = new THREE.BufferGeometry();
    boundaryGeometry.setAttribute('position', geometry.getAttribute('position'));
    boundaryGeometry.setIndex(this.boundaryIndex);
    const boundary = new THREE.LineSegments(boundaryGeometry, this.boundaryMaterial);
    boundary.name = `tile boundary ${data.id}`;
    boundary.renderOrder = 2;
    boundary.scale.copy(mesh.scale);
    boundary.visible = this.boundaryVisible;
    this.group.add(mesh);
    this.group.add(wireframe);
    this.group.add(boundary);
    const tile = { mesh, wireframe, boundary, data, seamSignature,
      copyBytes: positions.byteLength + normals.byteLength };
    this.tiles.set(data.id, tile);
    this.copiedMeshBytes += tile.copyBytes;
    this.lastCreated++;
    return tile;
  }

  private disposeTile(id: string): void {
    const tile = this.tiles.get(id);
    if (!tile) throw new Error(`TileRenderer.ts disposeTile: unknown GPU tile id=${id}; resident=${this.tiles.size}`);
    this.group.remove(tile.mesh);
    this.group.remove(tile.wireframe);
    this.group.remove(tile.boundary);
    tile.mesh.geometry.dispose();
    tile.wireframe.geometry.dispose();
    tile.boundary.geometry.dispose();
    this.copiedMeshBytes -= tile.copyBytes;
    this.tiles.delete(id);
    this.lastDisposed++;
  }

  private applyDrawRange(geometry: THREE.BufferGeometry): void {
    geometry.setDrawRange(0, this.skirts ? this.index.count : this.gridIndexCount);
  }

  private materialForLevel(level: number): THREE.MeshStandardNodeMaterial {
    const existing = this.materials[level];
    if (existing) return existing;
    const levelColor = new THREE.Color().setHSL((level * 0.137) % 1, 0.7, 0.55);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    const grid = attribute<'vec3'>('grid', 'vec3');
    const cell = grid.xy;
    // Anti-aliased distance to the nearest grid line, in pixels.
    const lineDistance = abs(fract(cell.sub(0.5)).sub(0.5)).div(fwidth(cell));
    const gridLine = float(1).sub(clamp(min(lineDistance.x, lineDistance.y), 0, 1));
    const base = mix(vertexColor(), vec3(levelColor.r, levelColor.g, levelColor.b), this.levelMix);
    const withGrid = mix(base, vec3(0.02, 0.02, 0.03), gridLine.mul(this.gridLines).mul(0.85));
    material.colorNode = mix(withGrid, vec3(1, 0, 0.85), grid.z.mul(this.skirtHighlight));
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    this.materials[level] = material;
    return material;
  }
}

/** Unique edges of the exact triangles submitted by buildTileIndices. */
function buildWireIndices(triangles: Uint32Array): Uint32Array {
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    for (const [a, b] of [[triangles[i], triangles[i + 1]], [triangles[i + 1], triangles[i + 2]], [triangles[i + 2], triangles[i]]]) {
      const lo = Math.min(a!, b!);
      const hi = Math.max(a!, b!);
      const id = `${lo}/${hi}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push(lo, hi);
    }
  }
  return new Uint32Array(edges);
}

function buildBoundaryIndices(n: number): Uint32Array {
  const edges: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    edges.push(i, i + 1);
    edges.push((n - 1) * n + i, (n - 1) * n + i + 1);
    edges.push(i * n, (i + 1) * n);
    edges.push(i * n + n - 1, (i + 1) * n + n - 1);
  }
  return new Uint32Array(edges);
}

function edgeVertex(edge: FaceEdge, s: number, n: number): number {
  switch (edge) {
    case 'u-': return s * n;
    case 'u+': return s * n + n - 1;
    case 'v-': return s;
    case 'v+': return (n - 1) * n + s;
  }
}

export function stitchEdges(data: TileMeshData, seams: Partial<Record<FaceEdge, LodNode>>, n: number): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(data.positions);
  const normals = new Float32Array(data.normals);
  for (const edge of FACE_EDGES) {
    const coarseNode = seams[edge];
    if (!coarseNode) continue;
    const coarse = coarseNode.data;
    if (!coarse) throw new Error(`TileRenderer.ts stitchEdges: coarse tile has no data; fine=${data.id}; edge=${edge}; coarse=${coarseNode.id}`);
    if (data.key.level !== coarse.key.level + 1) throw new Error(`TileRenderer.ts stitchEdges: expected one level difference; fine=${data.id}; coarse=${coarse.id}`);
    const sameLevelNeighbor = neighborKey(data.key, edge);
    const coarseEdge = sameEdgeOnNeighbor(data.key, edge);
    const reversed = edgeReversedOnNeighbor(data.key, edge);
    const along = coarseEdge[0] === 'u' ? sameLevelNeighbor.y : sameLevelNeighbor.x;
    const half = along % 2;
    // Endpoints are shared corners; moving them separately on two stitched edges
    // could make the result depend on edge iteration order.
    for (let s = 1; s < n - 1; s++) {
      const destination = edgeVertex(edge, s, n);
      const neighborIndex = reversed ? n - 1 - s : s;
      const coarsePosition = half * (n - 1) / 2 + neighborIndex / 2;
      const lower = Math.floor(coarsePosition);
      const upper = Math.ceil(coarsePosition);
      const blend = coarsePosition - lower;
      const a = edgeVertex(coarseEdge, lower, n);
      const b = edgeVertex(coarseEdge, upper, n);
      for (let axis = 0; axis < 3; axis++) {
        const originAxis = axis === 0 ? coarse.origin.x - data.origin.x : axis === 1 ? coarse.origin.y - data.origin.y : coarse.origin.z - data.origin.z;
        const target = originAxis + coarse.positions[a * 3 + axis]! * (1 - blend) + coarse.positions[b * 3 + axis]! * blend;
        const delta = target - positions[destination * 3 + axis]!;
        positions[destination * 3 + axis] = target;
        const skirtEdge = edge === 'v-' ? 0 : edge === 'v+' ? 1 : edge === 'u-' ? 2 : 3;
        const skirt = n * n + skirtEdge * n + s;
        // Skirt vertices retain their original depth under the deformed edge.
        positions[skirt * 3 + axis] = positions[skirt * 3 + axis]! + delta;
        normals[destination * 3 + axis] = coarse.normals[a * 3 + axis]! * (1 - blend) + coarse.normals[b * 3 + axis]! * blend;
        normals[skirt * 3 + axis] = normals[destination * 3 + axis]!;
      }
    }
  }
  return { positions, normals };
}
