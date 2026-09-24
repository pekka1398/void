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

export type TileColorMode = 'terrain' | 'level' | 'tint';

export interface TileRendererOptions {
  readonly resolution: number;
  readonly metersPerRenderUnit: number;
}

interface TileGpu {
  readonly mesh: THREE.Mesh;
  readonly data: TileMeshData;
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
  private readonly gridIndexCount: number;
  private readonly materials: THREE.MeshStandardNodeMaterial[] = [];
  private skirts = true;

  private readonly levelMix = uniform(0);
  private readonly gridLines = uniform(0);
  private readonly tileBorders = uniform(1);
  private readonly skirtHighlight = uniform(0);
  private readonly cellsPerSide: THREE.UniformNode<'float', number>;

  constructor(private readonly options: TileRendererOptions) {
    const { indices, gridIndexCount } = buildTileIndices(options.resolution);
    this.index = new THREE.BufferAttribute(indices, 1);
    this.gridIndexCount = gridIndexCount;
    this.cellsPerSide = uniform(options.resolution - 1);
    this.group.name = 'lod-tiles';
  }

  get drawnTileCount(): number {
    let count = 0;
    for (const tile of this.tiles.values()) if (tile.mesh.visible) count++;
    return count;
  }

  setColorMode(mode: TileColorMode): void {
    this.levelMix.value = mode === 'terrain' ? 0 : mode === 'level' ? 1 : 0.45;
  }
  setGridLines(enabled: boolean): void { this.gridLines.value = enabled ? 1 : 0; }
  setTileBorders(enabled: boolean): void { this.tileBorders.value = enabled ? 1 : 0; }
  setSkirtHighlight(enabled: boolean): void { this.skirtHighlight.value = enabled ? 1 : 0; }
  setSkirts(enabled: boolean): void {
    this.skirts = enabled;
    for (const tile of this.tiles.values()) this.applyDrawRange(tile.mesh.geometry);
  }

  /** Show exactly `render`, positioned relative to the body-fixed camera. */
  sync(render: readonly LodNode[], cameraPosition: Vec3): void {
    const wanted = new Set<string>();
    const scale = 1 / this.options.metersPerRenderUnit;
    for (const node of render) {
      const data = node.data;
      if (!data) continue;
      wanted.add(node.id);
      let tile = this.tiles.get(node.id);
      if (tile && tile.data !== data) {
        this.disposeTile(node.id);
        tile = undefined;
      }
      if (!tile) tile = this.createTile(data);
      tile.mesh.visible = true;
      // float64 subtraction on the CPU; only the small camera-relative offset reaches float32.
      tile.mesh.position.set(
        (data.origin.x - cameraPosition.x) * scale,
        (data.origin.y - cameraPosition.y) * scale,
        (data.origin.z - cameraPosition.z) * scale,
      );
    }
    for (const [id, tile] of this.tiles) {
      // Tile data stays cached in PlanetLod; only the GPU copy is released.
      if (!wanted.has(id)) this.disposeTile(id);
    }
  }

  dispose(): void {
    for (const id of [...this.tiles.keys()]) this.disposeTile(id);
    for (const material of this.materials) material.dispose();
  }

  private createTile(data: TileMeshData): TileGpu {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('grid', new THREE.BufferAttribute(data.grid, 3));
    geometry.setIndex(this.index);
    geometry.computeBoundingSphere();
    this.applyDrawRange(geometry);
    const mesh = new THREE.Mesh(geometry, this.materialForLevel(data.key.level));
    mesh.name = `tile ${data.id}`;
    mesh.scale.setScalar(1 / this.options.metersPerRenderUnit);
    mesh.matrixAutoUpdate = true;
    this.group.add(mesh);
    const tile = { mesh, data };
    this.tiles.set(data.id, tile);
    return tile;
  }

  private disposeTile(id: string): void {
    const tile = this.tiles.get(id);
    if (!tile) return;
    this.group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    this.tiles.delete(id);
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
    const edgeDistance = min(cell, this.cellsPerSide.sub(cell)).div(fwidth(cell));
    const border = float(1).sub(clamp(min(edgeDistance.x, edgeDistance.y).sub(1.5), 0, 1));
    const base = mix(vertexColor(), vec3(levelColor.r, levelColor.g, levelColor.b), this.levelMix);
    const withGrid = mix(base, vec3(0.02, 0.02, 0.03), gridLine.mul(this.gridLines).mul(0.85));
    const withBorder = mix(withGrid, vec3(1, 1, 1), border.mul(this.tileBorders));
    material.colorNode = mix(withBorder, vec3(1, 0, 0.85), grid.z.mul(this.skirtHighlight));
    this.materials[level] = material;
    return material;
  }
}
