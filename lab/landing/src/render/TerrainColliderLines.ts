import * as THREE from 'three/webgpu';
import type { ContactWorld, TileCollider } from '../physics/ContactWorld';
import type { Vec3 } from '../orbitCore';

/**
 * Green edges of the terrain triangles each loaded Rapier collider holds,
 * read back from the colliders themselves, in body-fixed axes. Add `group`
 * where body-fixed geometry is drawn.
 */
export class TerrainColliderLines {
  readonly group = new THREE.Group();
  private readonly lines = new Map<string, THREE.LineSegments>();
  private readonly material = new THREE.LineBasicMaterial({ color: 0x3dff6e, depthTest: true });
  private visible = true;

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  /** Match the colliders of every contact world; renderOrigin is the body-fixed point at the scene origin. */
  sync(worlds: readonly ContactWorld[], renderOrigin: Vec3): void {
    const live = new Map<string, TileCollider>();
    for (const world of worlds) for (const [id, tile] of world.terrainColliders()) live.set(id, tile);
    for (const [id, lines] of this.lines) {
      if (live.has(id)) continue;
      this.group.remove(lines);
      lines.geometry.dispose();
      this.lines.delete(id);
    }
    if (!this.visible) return;
    for (const [id, tile] of live) {
      let lines = this.lines.get(id);
      if (!lines) {
        // The collider's own triangles, relative to the tile origin (its translation in the contact world).
        const indices = tile.collider.indices();
        if (!indices) throw new Error(`TerrainColliderLines: terrain collider ${id} has no triangle indices`);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(tile.collider.vertices(), 3));
        geometry.setIndex(new THREE.BufferAttribute(uniqueEdges(indices), 1));
        lines = new THREE.LineSegments(geometry, this.material);
        // Over the white mesh edges (1), under the red tile boundaries (2).
        lines.renderOrder = 1.5;
        this.group.add(lines);
        this.lines.set(id, lines);
      }
      lines.position.set(tile.origin.x - renderOrigin.x, tile.origin.y - renderOrigin.y, tile.origin.z - renderOrigin.z);
    }
  }
}

function uniqueEdges(triangles: Uint32Array): Uint32Array {
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    for (const [a, b] of [[triangles[i]!, triangles[i + 1]!], [triangles[i + 1]!, triangles[i + 2]!], [triangles[i + 2]!, triangles[i]!]] as [number, number][]) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const id = `${lo}/${hi}`;
      if (!seen.has(id)) { seen.add(id); edges.push(lo, hi); }
    }
  }
  return new Uint32Array(edges);
}
