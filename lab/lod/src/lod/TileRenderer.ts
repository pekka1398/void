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

/**
 * Instance ids the batch can hold. Fixed: growing a BatchedMesh's instance
 * count replaces the matrix and color textures its compiled shader samples.
 * Drawn tiles stay near 1.7k and PlanetLod caches about 2.4k.
 */
const MAX_TILES = 4096;
/** Tile slots of vertex/index storage allocated at first, then grown by half. */
const INITIAL_SLOTS = 512;

interface TileGpu {
  /** Geometry id and instance id in the batch; the two are always equal. */
  readonly slot: number;
  readonly data: TileMeshData;
  /** tileCode of the coarser neighbor stitched along each FACE_EDGES edge, or -1. */
  readonly seams: readonly number[];
  /** Stitched positions, kept for the debug line overlays. */
  readonly positions: Float32Array;
  /** Debug overlays, built only while shown: thousands of hidden line objects still cost a sync. */
  wireframe: THREE.LineSegments | undefined;
  boundary: THREE.LineSegments | undefined;
  /** Origin-relative render position of the tile origin, for overlays built later. */
  readonly offset: THREE.Vector3;
  readonly copyBytes: number;
}

/**
 * Three.js adapter: draws every ready tile in one BatchedMesh (a single
 * multi-draw), each tile a fixed-size slot placed camera-relative through its
 * instance matrix (camera at the GPU origin), and exposes debug shading.
 * Nothing here feeds back into selection.
 */
export class TileRenderer {
  readonly group = new THREE.Group();
  private readonly tiles = new Map<string, TileGpu>();
  private readonly index: THREE.BufferAttribute;
  private readonly gridIndex: THREE.BufferAttribute;
  private readonly surfaceWireIndex: THREE.BufferAttribute;
  private readonly fullWireIndex: THREE.BufferAttribute;
  private readonly boundaryIndex: THREE.BufferAttribute;
  private readonly wireMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: true });
  private readonly boundaryMaterial = new THREE.LineBasicMaterial({ color: 0xff3030, depthTest: true });
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly batch: THREE.BatchedMesh;
  private readonly verticesPerTile: number;
  private readonly freeSlots: number[] = [];
  private slotCount = 0;
  private slotCapacity = INITIAL_SLOTS;
  private skirts = false;
  private lastCreated = 0;
  private lastDisposed = 0;
  private copiedMeshBytes = 0;
  private lastSelection: readonly LodNode[] = [];
  private lastOrigin: Vec3 | undefined;
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  /** Share of the per-level color in each tile's instance color. */
  private levelTint = 0;
  /** 1 replaces the terrain color by white so the instance color shows alone. */
  private readonly levelOnly = uniform(0);
  private readonly gridLines = uniform(0);
  private wireframeVisible = true;
  private boundaryVisible = true;
  private readonly skirtHighlight = uniform(0);

  constructor(private readonly options: TileRendererOptions) {
    const { indices, gridIndexCount } = buildTileIndices(options.resolution);
    this.index = new THREE.BufferAttribute(indices, 1);
    this.gridIndex = new THREE.BufferAttribute(indices.slice(0, gridIndexCount), 1);
    this.surfaceWireIndex = new THREE.BufferAttribute(buildWireIndices(indices.subarray(0, gridIndexCount)), 1);
    this.fullWireIndex = new THREE.BufferAttribute(buildWireIndices(indices), 1);
    this.boundaryIndex = new THREE.BufferAttribute(buildBoundaryIndices(options.resolution), 1);
    this.verticesPerTile = options.resolution * options.resolution + 4 * options.resolution;
    this.material = this.createMaterial();
    this.batch = new THREE.BatchedMesh(MAX_TILES, INITIAL_SLOTS * this.verticesPerTile, INITIAL_SLOTS * this.index.count, this.material);
    this.batch.name = 'lod tiles';
    // Instances move every frame, so a whole-batch bound would go stale; each tile is culled on its own.
    this.batch.frustumCulled = false;
    this.batch.perObjectFrustumCulled = true;
    // An empty batch has no vertex attributes yet; drawing it would compile the shader without them
    // and keep that program after tiles arrive. It stays hidden until its first geometry.
    this.batch.visible = false;
    this.group.name = 'lod-tiles';
    this.group.add(this.batch);
  }

  get drawnTileCount(): number { return this.tiles.size; }
  get createdLastSync(): number { return this.lastCreated; }
  get disposedLastSync(): number { return this.lastDisposed; }
  /** CPU copies: the batch's vertex and index arrays at their current capacity, plus per-tile line positions. */
  get rendererCopyBytes(): number {
    let batchBytes = this.batch.geometry.index?.array.byteLength ?? 0;
    for (const name in this.batch.geometry.attributes) batchBytes += this.batch.geometry.getAttribute(name).array.byteLength;
    return this.copiedMeshBytes + batchBytes;
  }

  setColorMode(mode: TileColorMode): void {
    this.levelOnly.value = mode === 'level' ? 1 : 0;
    this.levelTint = mode === 'terrain' ? 0 : mode === 'level' ? 1 : 0.45;
    for (const tile of this.tiles.values()) this.applyLevelColor(tile.slot, tile.data.key.level);
  }
  setGridLines(enabled: boolean): void { this.gridLines.value = enabled ? 1 : 0; }
  setMeshWireframe(enabled: boolean): void {
    this.wireframeVisible = enabled;
    for (const tile of this.tiles.values()) this.updateOverlays(tile);
  }
  setTileBoundaries(enabled: boolean): void {
    this.boundaryVisible = enabled;
    for (const tile of this.tiles.values()) this.updateOverlays(tile);
  }
  /**
   * Draw the tiles with the caller's material (lab/scenery's lit ground and sea). Tile vertices carry
   * position, normal, color, height (metres above the reference radius) and grid. The debug shading
   * (level colors, grid lines, skirt highlight) belongs to the default material and stops showing.
   * The caller owns the material and disposes it.
   */
  setMaterial(material: THREE.Material): void { this.batch.material = material; }
  setSkirtHighlight(enabled: boolean): void { this.skirtHighlight.value = enabled ? 1 : 0; }
  setSkirts(enabled: boolean): void {
    if (enabled === this.skirts) return;
    this.skirts = enabled;
    // Each slot's index count is fixed when it is written; rebuild every tile on the next sync.
    for (const id of [...this.tiles.keys()]) this.disposeTile(id);
    this.lastSelection = [];
    this.lastOrigin = undefined;
  }

  /** Show exactly `render`, positioned relative to the body-fixed camera. */
  sync(render: readonly LodNode[], cameraPosition: Vec3): void {
    this.lastCreated = 0;
    this.lastDisposed = 0;
    const sameSelection = render.length === this.lastSelection.length && render.every((node, index) =>
      node === this.lastSelection[index] && this.tiles.get(node.id)?.data === node.data);
    if (sameSelection) {
      if (!this.lastOrigin || this.lastOrigin.x !== cameraPosition.x || this.lastOrigin.y !== cameraPosition.y || this.lastOrigin.z !== cameraPosition.z) {
        for (const node of render) {
          const tile = this.tiles.get(node.id);
          if (!tile) throw new Error(`TileRenderer.ts sync: unchanged selection lost tile; id=${node.id}`);
          this.positionTile(tile, cameraPosition);
        }
        this.lastOrigin = { ...cameraPosition };
      }
      return;
    }
    const wanted = new Set<string>();
    const selected = new Map(render.map((node) => [node.code, node]));
    for (const node of render) wanted.add(node.id);
    // Free slots of tiles that leave first, so arrivals reuse them before the storage grows.
    for (const id of [...this.tiles.keys()]) {
      // Tile data stays cached in PlanetLod; only the GPU copy is released.
      if (!wanted.has(id)) this.disposeTile(id);
    }
    for (const node of render) {
      const data = node.data;
      if (!data) throw new Error(`TileRenderer.ts sync: render selection has no mesh; id=${node.id}; level=${node.key.level}; camera=${JSON.stringify(cameraPosition)}`);
      const seamNodes: Partial<Record<FaceEdge, LodNode>> = {};
      const seams: number[] = [];
      for (const edge of FACE_EDGES) {
        const neighbor = selectedNeighbor(selected, node.key, edge);
        const difference = neighbor ? node.key.level - neighbor.key.level : 0;
        if (difference > 1) throw new Error(`TileRenderer.ts sync: adjacent LOD gap exceeds one; tile=${node.id}; edge=${edge}; neighbor=${neighbor?.id}`);
        if (neighbor && difference === 1) seamNodes[edge] = neighbor;
        seams.push(neighbor && difference === 1 ? neighbor.code : -1);
      }
      let tile = this.tiles.get(node.id);
      if (tile && (tile.data !== data || tile.seams.some((code, index) => code !== seams[index]))) {
        this.disposeTile(node.id);
        tile = undefined;
      }
      if (!tile) tile = this.createTile(data, seamNodes, seams);
      this.positionTile(tile, cameraPosition);
    }
    this.lastSelection = [...render];
    this.lastOrigin = { ...cameraPosition };
  }

  dispose(): void {
    for (const id of [...this.tiles.keys()]) this.disposeTile(id);
    this.lastSelection = [];
    this.lastOrigin = undefined;
    this.batch.dispose();
    this.material.dispose();
    this.wireMaterial.dispose();
    this.boundaryMaterial.dispose();
  }

  private createTile(data: TileMeshData, seamNodes: Partial<Record<FaceEdge, LodNode>>, seams: readonly number[]): TileGpu {
    const stitched = stitchEdges(data, seamNodes, this.options.resolution);
    const positions = stitched.positions;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(stitched.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('height', new THREE.BufferAttribute(stitched.heights, 1));
    geometry.setAttribute('grid', new THREE.BufferAttribute(data.grid, 3));
    geometry.setIndex(this.skirts ? this.index : this.gridIndex);
    geometry.boundingSphere = originSphere(stitched.positions);
    const slot = this.acquireSlot(geometry);
    this.applyLevelColor(slot, data.key.level);
    const tile: TileGpu = { slot, data, seams, positions, wireframe: undefined, boundary: undefined,
      offset: new THREE.Vector3(), copyBytes: stitched.positions.byteLength };
    this.tiles.set(data.id, tile);
    this.copiedMeshBytes += tile.copyBytes;
    this.lastCreated++;
    this.updateOverlays(tile);
    return tile;
  }

  /** Build or drop a tile's debug line overlays to match the current toggles. */
  private updateOverlays(tile: TileGpu): void {
    if (this.wireframeVisible && !tile.wireframe) {
      tile.wireframe = this.createOverlay(tile, this.skirts ? this.fullWireIndex : this.surfaceWireIndex, this.wireMaterial, 1, `mesh edges ${tile.data.id}`);
    } else if (!this.wireframeVisible && tile.wireframe) {
      this.removeOverlay(tile.wireframe);
      tile.wireframe = undefined;
    }
    if (this.boundaryVisible && !tile.boundary) {
      tile.boundary = this.createOverlay(tile, this.boundaryIndex, this.boundaryMaterial, 2, `tile boundary ${tile.data.id}`);
    } else if (!this.boundaryVisible && tile.boundary) {
      this.removeOverlay(tile.boundary);
      tile.boundary = undefined;
    }
  }

  private createOverlay(tile: TileGpu, index: THREE.BufferAttribute, material: THREE.LineBasicMaterial, renderOrder: number, name: string): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    // Its own attribute over the shared array: disposing one overlay must not free the other's buffer.
    geometry.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
    geometry.setIndex(index);
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = name;
    lines.renderOrder = renderOrder;
    lines.scale.setScalar(1 / this.options.metersPerRenderUnit);
    lines.position.copy(tile.offset);
    this.group.add(lines);
    return lines;
  }

  private removeOverlay(lines: THREE.LineSegments): void {
    this.group.remove(lines);
    lines.geometry.dispose();
  }

  /** Write `geometry` into a free slot, growing the batch's storage when every slot is taken. */
  private acquireSlot(geometry: THREE.BufferGeometry): number {
    const free = this.freeSlots.pop();
    if (free !== undefined) {
      this.batch.setGeometryAt(free, geometry);
      this.batch.setVisibleAt(free, true);
      return free;
    }
    if (this.slotCount >= MAX_TILES) throw new Error(`TileRenderer.ts acquireSlot: more than ${MAX_TILES} resident tiles`);
    if (this.slotCount >= this.slotCapacity) {
      this.slotCapacity = Math.min(MAX_TILES, Math.ceil(this.slotCapacity * 1.5));
      this.batch.setGeometrySize(this.slotCapacity * this.verticesPerTile, this.slotCapacity * this.index.count);
    }
    // Every slot reserves room for skirts, so a slot written without them can later hold a tile with them.
    const geometryId = this.batch.addGeometry(geometry, this.verticesPerTile, this.index.count);
    const instanceId = this.batch.addInstance(geometryId);
    if (geometryId !== this.slotCount || instanceId !== this.slotCount) {
      throw new Error(`TileRenderer.ts acquireSlot: batch ids out of step; geometry=${geometryId}; instance=${instanceId}; slots=${this.slotCount}`);
    }
    this.slotCount++;
    this.batch.visible = true;
    return geometryId;
  }

  private disposeTile(id: string): void {
    const tile = this.tiles.get(id);
    if (!tile) throw new Error(`TileRenderer.ts disposeTile: unknown GPU tile id=${id}; resident=${this.tiles.size}`);
    this.batch.setVisibleAt(tile.slot, false);
    this.freeSlots.push(tile.slot);
    if (tile.wireframe) this.removeOverlay(tile.wireframe);
    if (tile.boundary) this.removeOverlay(tile.boundary);
    this.copiedMeshBytes -= tile.copyBytes;
    this.tiles.delete(id);
    this.lastDisposed++;
  }

  private positionTile(tile: TileGpu, origin: Vec3): void {
    const scale = 1 / this.options.metersPerRenderUnit;
    const data = tile.data;
    // float64 subtraction on the CPU; only the small origin-relative offset reaches float32.
    tile.offset.set((data.origin.x - origin.x) * scale, (data.origin.y - origin.y) * scale, (data.origin.z - origin.z) * scale);
    this.matrix.makeScale(scale, scale, scale).setPosition(tile.offset);
    this.batch.setMatrixAt(tile.slot, this.matrix);
    tile.wireframe?.position.copy(tile.offset);
    tile.boundary?.position.copy(tile.offset);
  }

  private applyLevelColor(slot: number, level: number): void {
    this.color.setHSL((level * 0.137) % 1, 0.7, 0.55).lerp(WHITE, 1 - this.levelTint);
    this.batch.setColorAt(slot, this.color);
  }

  private createMaterial(): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    const grid = attribute<'vec3'>('grid', 'vec3');
    const cell = grid.xy;
    // Anti-aliased distance to the nearest grid line, in pixels.
    const lineDistance = abs(fract(cell.sub(0.5)).sub(0.5)).div(fwidth(cell));
    const gridLine = float(1).sub(clamp(min(lineDistance.x, lineDistance.y), 0, 1));
    // The batch multiplies this by each tile's instance color, which carries the level tint.
    const base = mix(vertexColor(), vec3(1, 1, 1), this.levelOnly);
    const withGrid = mix(base, vec3(0.02, 0.02, 0.03), gridLine.mul(this.gridLines).mul(0.85));
    material.colorNode = mix(withGrid, vec3(1, 0, 0.85), grid.z.mul(this.skirtHighlight));
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    return material;
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/**
 * Bounding sphere about the tile origin (local 0,0,0) in one pass over the
 * positions. A little looser than BufferGeometry.computeBoundingSphere's,
 * which builds a box and a center first; both enclose every vertex.
 */
function originSphere(positions: Float32Array): THREE.Sphere {
  let largest = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    const squared = x * x + y * y + z * z;
    if (squared > largest) largest = squared;
  }
  return new THREE.Sphere(new THREE.Vector3(), Math.sqrt(largest));
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

export function stitchEdges(data: TileMeshData, seams: Partial<Record<FaceEdge, LodNode>>, n: number): { positions: Float32Array; normals: Float32Array; heights: Float32Array } {
  const positions = new Float32Array(data.positions);
  const normals = new Float32Array(data.normals);
  const heights = new Float32Array(data.heights);
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
      const skirtEdge = edge === 'v-' ? 0 : edge === 'v+' ? 1 : edge === 'u-' ? 2 : 3;
      const skirt = n * n + skirtEdge * n + s;
      heights[destination] = coarse.heights[a]! * (1 - blend) + coarse.heights[b]! * blend;
      heights[skirt] = heights[destination]!;
      for (let axis = 0; axis < 3; axis++) {
        const originAxis = axis === 0 ? coarse.origin.x - data.origin.x : axis === 1 ? coarse.origin.y - data.origin.y : coarse.origin.z - data.origin.z;
        const target = originAxis + coarse.positions[a * 3 + axis]! * (1 - blend) + coarse.positions[b * 3 + axis]! * blend;
        const delta = target - positions[destination * 3 + axis]!;
        positions[destination * 3 + axis] = target;
        // Skirt vertices retain their original depth under the deformed edge.
        positions[skirt * 3 + axis] = positions[skirt * 3 + axis]! + delta;
        normals[destination * 3 + axis] = coarse.normals[a * 3 + axis]! * (1 - blend) + coarse.normals[b * 3 + axis]! * blend;
        normals[skirt * 3 + axis] = normals[destination * 3 + axis]!;
      }
    }
  }
  return { positions, normals, heights };
}
