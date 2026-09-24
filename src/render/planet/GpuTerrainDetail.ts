import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshLambertMaterial,
  Vector3,
} from 'three';
import {
  attribute,
  float,
  Fn,
  instanceIndex,
  materialColor,
  materialNormal,
  mix,
  storage,
  transformNormalToView,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import {
  MeshLambertNodeMaterial,
  StorageBufferAttribute,
  type ComputeNode,
  type Node,
  type WebGPURenderer,
} from 'three/webgpu';

const TERRAIN_DETAIL_ATTRIBUTE = 'gpuTerrainDetail';
const TERRAIN_GEOLOGY_ATTRIBUTE = 'gpuTerrainGeology';
const MAX_TILE_VERTICES = 4_225;
const WORKGROUP_SIZE = 64;

interface TerrainComputeGrid {
  readonly side: number;
  readonly gridVertexCount: number;
  readonly skirtVertexCount: number;
}

/** Only the unchanged square-grid prefix belongs to the neighborhood kernel. */
function terrainComputeGrid(geometry: BufferGeometry, renderVertexCount: number): TerrainComputeGrid | undefined {
  const gridVertexCount = geometry.userData.gridVertexCount ?? renderVertexCount;
  if (!Number.isInteger(gridVertexCount) || gridVertexCount <= 0 || gridVertexCount > MAX_TILE_VERTICES ||
      gridVertexCount > renderVertexCount) return undefined;
  const side = Math.sqrt(gridVertexCount);
  const skirtVertexCount = renderVertexCount - gridVertexCount;
  if (!Number.isInteger(side) || side < 3 ||
      (skirtVertexCount !== 0 && skirtVertexCount !== 4 * side) ||
      (geometry.userData.gridSegments !== undefined && geometry.userData.gridSegments !== side - 1) ||
      (geometry.userData.skirtVertexCount !== undefined && geometry.userData.skirtVertexCount !== skirtVertexCount)) {
    return undefined;
  }
  return { side, gridVertexCount, skirtVertexCount };
}

type TerrainMaterial = MeshLambertMaterial | MeshLambertNodeMaterial;

interface PreparedTerrainTile {
  readonly mesh: Mesh;
  readonly geometry: BufferGeometry;
  readonly source: StorageBufferAttribute;
  readonly detail: StorageBufferAttribute;
  readonly geology: StorageBufferAttribute;
  readonly compute: ComputeNode;
  readonly vertexCount: number;
  readonly onDispose: () => void;
  material: TerrainMaterial;
  dispatched: boolean;
}

interface TerrainMaterialState {
  references: number;
  readonly ownColorNode: boolean;
  readonly originalColorNode: TerrainMaterial['colorNode'];
  readonly ownNormalNode: boolean;
  readonly originalNormalNode: TerrainMaterial['normalNode'];
}

export interface GpuTerrainDetailStats {
  readonly enabled: boolean;
  readonly prepared: number;
  readonly pending: number;
  readonly dispatches: number;
  readonly vertices: number;
  readonly resident: number;
  readonly released: number;
  readonly failed: number;
}

/**
 * Derive visual terrain detail on the actual WebGPU device. Worker-produced
 * field positions, sampled colors, topology, collision, and wet masks remain
 * untouched. The WebGL backend never allocates storage or dispatches compute.
 */
export class GpuTerrainDetail {
  readonly enabled: boolean;

  private readonly renderer: WebGPURenderer;
  private readonly records = new Map<string, PreparedTerrainTile>();
  private readonly meshGeometries = new WeakMap<Mesh, BufferGeometry>();
  private readonly materials = new Map<TerrainMaterial, TerrainMaterialState>();
  private readonly rejected = new WeakSet<BufferGeometry>();
  private readonly pending: PreparedTerrainTile[] = [];
  private preparedCount = 0;
  private dispatchCount = 0;
  private vertexCount = 0;
  private releasedCount = 0;
  private failedCount = 0;
  private disposed = false;
  private computeDisabled = false;

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
    const backend = renderer.backend as typeof renderer.backend & {
      isWebGPUBackend?: boolean;
      device?: unknown;
    };
    this.enabled = backend?.isWebGPUBackend === true && Boolean(backend.device);
  }

  get stats(): GpuTerrainDetailStats {
    return {
      enabled: this.enabled && !this.computeDisabled,
      prepared: this.preparedCount,
      pending: this.pending.length,
      dispatches: this.dispatchCount,
      vertices: this.vertexCount,
      resident: this.records.size,
      released: this.releasedCount,
      failed: this.failedCount,
    };
  }

  /** Queue an indexed, real worker tile; duplicate calls are constant-time. */
  prepare(mesh: Mesh, bodyFixedCenter: Vector3 = mesh.position): boolean {
    if (!this.enabled || this.computeDisabled || this.disposed) return false;
    if (!(mesh.geometry instanceof BufferGeometry) || Array.isArray(mesh.material)) return false;
    if (!(mesh.material instanceof MeshLambertMaterial) && !(mesh.material instanceof MeshLambertNodeMaterial)) return false;

    const previous = this.meshGeometries.get(mesh);
    if (previous && previous !== mesh.geometry) this.releaseGeometry(previous);
    const existing = this.records.get(mesh.geometry.uuid);
    if (existing) {
      this.syncMaterial(existing, mesh.material);
      return false;
    }
    if (this.rejected.has(mesh.geometry)) return false;

    const positions = mesh.geometry.getAttribute('position');
    const colors = mesh.geometry.getAttribute('color');
    const normals = mesh.geometry.getAttribute('normal');
    if (!(positions instanceof BufferAttribute) || !(colors instanceof BufferAttribute)) return false;
    if (!mesh.geometry.index || positions.count !== colors.count) return false;
    const grid = terrainComputeGrid(mesh.geometry, positions.count);
    if (!grid) return false;
    const { side, gridVertexCount, skirtVertexCount } = grid;

    try {
      // Skirts are render-only vertical walls, not neighbors in the physical
      // heightfield. Storage attributes must nevertheless cover every vertex
      // fetched by the indexed draw, with neutral wall relief/geology.
      const sourceValues = new Float32Array(gridVertexCount * 4);
      const detailValues = new Float32Array(positions.count * 4);
      const geologyValues = new Float32Array(positions.count * 4);
      for (let index = 0; index < positions.count; index += 1) {
        const offset = index * 4;
        // Explicit vec4 packing avoids Three r185 mutating a real vec3
        // BufferAttribute while padding WebGPU storage-buffer alignment.
        if (index < gridVertexCount) {
          sourceValues[offset] = positions.getX(index);
          sourceValues[offset + 1] = positions.getY(index);
          sourceValues[offset + 2] = positions.getZ(index);
          sourceValues[offset + 3] = colors.getX(index) * 0.2126 +
            colors.getY(index) * 0.7152 + colors.getZ(index) * 0.0722;
        }
        if (normals instanceof BufferAttribute && normals.count === positions.count) {
          detailValues[offset] = normals.getX(index);
          detailValues[offset + 1] = normals.getY(index);
          detailValues[offset + 2] = normals.getZ(index);
        } else {
          const x = positions.getX(index) + bodyFixedCenter.x;
          const y = positions.getY(index) + bodyFixedCenter.y;
          const z = positions.getZ(index) + bodyFixedCenter.z;
          const inverseLength = 1 / Math.max(Number.EPSILON, Math.hypot(x, y, z));
          detailValues[offset] = x * inverseLength;
          detailValues[offset + 1] = y * inverseLength;
          detailValues[offset + 2] = z * inverseLength;
        }
        // A neutral fourth channel keeps the genuine original vertex colors
        // intact if the mesh is rendered before its queued compute dispatch.
        detailValues[offset + 3] = 0;
      }

      const source = new StorageBufferAttribute(sourceValues, 4);
      const detail = new StorageBufferAttribute(detailValues, 4);
      const geology = new StorageBufferAttribute(geologyValues, 4);
      const sourceNode = storage(source, 'vec4', gridVertexCount).toReadOnly();
      const detailNode = storage(detail, 'vec4', positions.count);
      const geologyNode = storage(geology, 'vec4', positions.count);
      const center = uniform(bodyFixedCenter.clone());
      const bodyRadiusMeters = mesh.parent?.userData.planetField?.radius;
      const metersPerRenderUnit = uniform(
        typeof bodyRadiusMeters === 'number' && Number.isFinite(bodyRadiusMeters)
          ? bodyRadiusMeters / Math.max(0.000_001, bodyFixedCenter.length())
          : 140_000,
      );
      const sideCount = uint(side);

      const compute = Fn(() => {
        const index = instanceIndex;
        const column = index.mod(sideCount);
        const row = index.div(sideCount);
        const westIndex = column.greaterThan(uint(0)).select(index.sub(uint(1)), index);
        const eastIndex = column.lessThan(sideCount.sub(uint(1)))
          .select(index.add(uint(1)), index);
        const southIndex = row.greaterThan(uint(0)).select(index.sub(sideCount), index);
        const northIndex = row.lessThan(sideCount.sub(uint(1)))
          .select(index.add(sideCount), index);
        const westValid = column.greaterThan(uint(0));
        const eastValid = column.lessThan(sideCount.sub(uint(1)));
        const southValid = row.greaterThan(uint(0));
        const northValid = row.lessThan(sideCount.sub(uint(1)));
        const southwestIndex = westValid.and(southValid)
          .select(index.sub(sideCount).sub(uint(1)), index);
        const southeastIndex = eastValid.and(southValid)
          .select(index.sub(sideCount).add(uint(1)), index);
        const northwestIndex = westValid.and(northValid)
          .select(index.add(sideCount).sub(uint(1)), index);
        const northeastIndex = eastValid.and(northValid)
          .select(index.add(sideCount).add(uint(1)), index);

        const current = sourceNode.element(index);
        const west = sourceNode.element(westIndex);
        const east = sourceNode.element(eastIndex);
        const south = sourceNode.element(southIndex);
        const north = sourceNode.element(northIndex);
        const southwest = sourceNode.element(southwestIndex);
        const southeast = sourceNode.element(southeastIndex);
        const northwest = sourceNode.element(northwestIndex);
        const northeast = sourceNode.element(northeastIndex);
        const tangent = east.xyz.sub(west.xyz);
        const bitangent = north.xyz.sub(south.xyz);
        const cross = tangent.cross(bitangent);
        const bodyPosition = current.xyz.add(center);
        const physicalRadius = bodyPosition.length();
        const physicalUp = bodyPosition.div(physicalRadius.max(0.0000001));
        const candidate = cross.div(cross.length().max(0.0000001));
        const outward = candidate.dot(physicalUp).lessThan(0)
          .select(candidate.negate(), candidate);
        const upAlignment = outward.dot(physicalUp).abs().clamp(0, 1);
        // sin(slope) remains readable on physically plausible 2–15° slopes;
        // 1-cos(slope) previously collapsed nearly every real mountain to 0.
        const slope = float(1).sub(upAlignment.mul(upAlignment)).max(0).sqrt().clamp(0, 1);
        const neighbors = west.w.add(east.w).add(south.w).add(north.w).mul(0.25);
        const geologicalContrast = current.w.sub(neighbors).abs().mul(3.2).clamp(0, 1);
        const axialRadius = west.xyz.add(center).length()
          .add(east.xyz.add(center).length())
          .add(south.xyz.add(center).length())
          .add(north.xyz.add(center).length())
          .mul(0.25);
        const diagonalRadius = southwest.xyz.add(center).length()
          .add(southeast.xyz.add(center).length())
          .add(northwest.xyz.add(center).length())
          .add(northeast.xyz.add(center).length())
          .mul(0.25);
        const neighborhoodRadius = axialRadius.mul(0.68).add(diagonalRadius.mul(0.32));
        const cellWidth = tangent.length().add(bitangent.length()).mul(0.25).max(0.0000001);
        const signedCurvature = physicalRadius.sub(neighborhoodRadius)
          .div(cellWidth)
          .mul(3.8)
          .clamp(-1, 1);
        const cavity = signedCurvature.negate().max(0)
          .mul(float(0.38).add(slope.mul(1.3)))
          .clamp(0, 1);
        const ridge = signedCurvature.max(0)
          .mul(float(0.46).add(slope.mul(1.1)))
          .clamp(0, 1);
        // The stratum is anchored to the actual body-fixed physical radius,
        // never the camera, tile order, or an invented heightfield.
        const heightMeters = physicalRadius.mul(metersPerRenderUnit);
        const strata = heightMeters.mul(0.034)
          .add(current.w.mul(4.2))
          .sin()
          .mul(0.5)
          .add(0.5);
        const detailVisibility = float(1).sub(cellWidth.mul(metersPerRenderUnit).smoothstep(324, 1_296));
        const relief = slope.mul(1.16)
          .add(geologicalContrast.mul(0.24))
          .add(ridge.mul(0.23))
          .add(cavity.mul(0.12))
          .clamp(0, 1).mul(detailVisibility);
        detailNode.element(index).assign(vec4(outward, relief));
        geologyNode.element(index).assign(vec4(slope.mul(detailVisibility), cavity.mul(detailVisibility),
          ridge.mul(detailVisibility), strata));
      })().compute(gridVertexCount, [WORKGROUP_SIZE]);
      compute.setName(`shared-field-terrain-detail/${mesh.geometry.uuid}`);

      mesh.geometry.setAttribute(TERRAIN_DETAIL_ATTRIBUTE, detail);
      mesh.geometry.setAttribute(TERRAIN_GEOLOGY_ATTRIBUTE, geology);
      mesh.geometry.userData.gpuTerrainDetail = 'authoritative-position-normal-slope';
      mesh.geometry.userData.gpuTerrainGeology = 'authoritative-slope-curvature-ambient-occlusion-strata';
      mesh.geometry.userData.gpuTerrainGeologyChannels = ['slope', 'cavity', 'ridge', 'body-fixed-strata'];
      mesh.geometry.userData.gpuTerrainNeighborhoodSamples = 9;
      mesh.geometry.userData.gpuTerrainWorkgroupSize = WORKGROUP_SIZE;
      mesh.geometry.userData.gpuTerrainGridVertices = gridVertexCount;
      mesh.geometry.userData.gpuTerrainRenderVertices = positions.count;
      mesh.geometry.userData.gpuTerrainNeutralSkirtVertices = skirtVertexCount;
      mesh.userData.gpuTerrainDetail = true;

      const geometry = mesh.geometry;
      const onDispose = () => this.releaseGeometry(geometry);
      const record: PreparedTerrainTile = {
        mesh,
        geometry,
        source,
        detail,
        geology,
        compute,
        vertexCount: gridVertexCount,
        onDispose,
        material: mesh.material,
        dispatched: false,
      };
      geometry.addEventListener('dispose', onDispose);
      this.records.set(geometry.uuid, record);
      this.meshGeometries.set(mesh, geometry);
      this.acquireMaterial(mesh.material);
      this.pending.push(record);
      this.preparedCount += 1;
      return true;
    } catch {
      this.rejected.add(mesh.geometry);
      this.failedCount += 1;
      return false;
    }
  }

  /** Submit at most two authentic worker-tile compute kernels per frame. */
  flush(max = 2): number {
    if (!this.enabled || this.computeDisabled || this.disposed) return 0;
    const limit = Math.max(0, Math.min(2, Math.floor(max)));
    if (limit === 0 || this.pending.length === 0) return 0;

    const selected: PreparedTerrainTile[] = [];
    while (selected.length < limit && this.pending.length > 0) {
      const record = this.pending.shift()!;
      if (this.records.get(record.geometry.uuid) !== record) continue;
      if (record.mesh.geometry !== record.geometry) {
        this.releaseGeometry(record.geometry);
        continue;
      }
      selected.push(record);
    }
    if (selected.length === 0) return 0;

    try {
      this.renderer.compute(selected.map((record) => record.compute));
      for (const record of selected) {
        record.dispatched = true;
        record.geometry.userData.gpuTerrainComputed = true;
        this.dispatchCount += 1;
        this.vertexCount += record.vertexCount;
      }
      return selected.length;
    } catch {
      this.failedCount += selected.length;
      this.computeDisabled = true;
      this.release();
      return 0;
    }
  }

  /** Release one stitched/evicted mesh, or every prepared tile when omitted. */
  release(mesh?: Mesh): void {
    if (mesh) {
      const geometry = this.meshGeometries.get(mesh) ?? mesh.geometry;
      this.releaseGeometry(geometry);
      this.meshGeometries.delete(mesh);
      return;
    }
    for (const record of [...this.records.values()]) this.releaseGeometry(record.geometry);
    this.pending.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
  }

  private syncMaterial(record: PreparedTerrainTile, next: TerrainMaterial): void {
    if (record.material === next) return;
    this.releaseMaterial(record.material);
    record.material = next;
    this.acquireMaterial(next);
  }

  private acquireMaterial(material: TerrainMaterial): void {
    const current = this.materials.get(material);
    if (current) {
      current.references += 1;
      return;
    }

    const state: TerrainMaterialState = {
      references: 1,
      ownColorNode: Object.prototype.hasOwnProperty.call(material, 'colorNode'),
      originalColorNode: material.colorNode,
      ownNormalNode: Object.prototype.hasOwnProperty.call(material, 'normalNode'),
      originalNormalNode: material.normalNode,
    };
    // Preserve the shared linear albedo/ring/weather graph. Optional GPU detail
    // is a small multiplier, not a replacement material or another LOD palette.
    // Legacy NodeLibrary conversion and native node materials share this path.
    // NodeMaterial accepts scalar/color/vector color nodes and performs this
    // same vec4 conversion; the pinned declaration narrows its overloads.
    const commonColor = vec4((state.originalColorNode ?? materialColor) as Node<'vec4'>);
    material.colorNode = Fn((builder) => {
      if (!builder.geometry?.hasAttribute(TERRAIN_DETAIL_ATTRIBUTE) ||
        !builder.geometry?.hasAttribute(TERRAIN_GEOLOGY_ATTRIBUTE)) return commonColor;
      const detail = attribute<'vec4'>(TERRAIN_DETAIL_ATTRIBUTE, 'vec4');
      const geology = attribute<'vec4'>(TERRAIN_GEOLOGY_ATTRIBUTE, 'vec4');
      const relief = detail.w.clamp(0, 1);
      const slope = geology.x.clamp(0, 1);
      const cavity = geology.y.clamp(0, 1);
      const ridge = geology.z.clamp(0, 1);
      const strata = geology.w.clamp(0, 1);
      const orientation = detail.xyz.abs().dot(vec3(0.23, 0.34, 0.18));
      const terrace = strata.mul(4).floor().mul(0.018).sub(0.026).mul(relief);
      const geologicalLight = float(1)
        .add(relief.mul(0.07))
        .add(orientation.mul(slope).mul(0.08))
        .add(ridge.mul(0.12))
        .sub(cavity.mul(0.16))
        .add(terrace)
        .clamp(0.78, 1.22);
      const ridgeViolet = vec3(0.048, 0.013, 0.068)
        .mul(ridge.mul(0.62).add(slope.mul(0.11)))
        .mul(strata.mul(0.42).add(0.58));
      const mineralTeal = vec3(0.0072, 0.03, 0.0276)
        .mul(slope)
        .mul(strata.smoothstep(0.7, 0.96))
        .mul(0.39);
      const detailColor = vec3(geologicalLight).add(ridgeViolet).add(mineralTeal);
      return vec4(commonColor.rgb.mul(detailColor), commonColor.a);
    })();
    // Keep the common flat physical facets at coarse scales. Only resolved
    // local relief receives a bounded blend toward its nine-neighbor normal.
    const commonNormal = state.originalNormalNode ? vec3(state.originalNormalNode as Node<'vec3'>) : materialNormal;
    material.normalNode = Fn((builder) => {
      if (!builder.geometry?.hasAttribute(TERRAIN_DETAIL_ATTRIBUTE)) {
        return commonNormal;
      }
      const detail = attribute<'vec4'>(TERRAIN_DETAIL_ATTRIBUTE, 'vec4');
      const computed = transformNormalToView(detail.xyz.normalize());
      return mix(commonNormal, computed, detail.w.clamp(0, 1).mul(0.28)).normalize();
    })();
    material.userData.physicalComputedTerrainNormals = true;
    material.userData.composesSharedPlanetAppearance = true;
    material.needsUpdate = true;
    this.materials.set(material, state);
  }

  private releaseMaterial(material: TerrainMaterial): void {
    const state = this.materials.get(material);
    if (!state) return;
    state.references -= 1;
    if (state.references > 0) return;
    if (state.ownColorNode) material.colorNode = state.originalColorNode;
    else delete (material as { colorNode?: TerrainMaterial['colorNode'] }).colorNode;
    if (state.ownNormalNode) material.normalNode = state.originalNormalNode;
    else delete (material as { normalNode?: TerrainMaterial['normalNode'] }).normalNode;
    delete material.userData.physicalComputedTerrainNormals;
    delete material.userData.composesSharedPlanetAppearance;
    material.needsUpdate = true;
    this.materials.delete(material);
  }

  private releaseGeometry(geometry: BufferGeometry): void {
    const record = this.records.get(geometry.uuid);
    if (!record) return;
    this.records.delete(geometry.uuid);
    geometry.removeEventListener('dispose', record.onDispose);
    const queued = this.pending.indexOf(record);
    if (queued !== -1) this.pending.splice(queued, 1);
    if (geometry.getAttribute(TERRAIN_DETAIL_ATTRIBUTE) === record.detail) {
      geometry.deleteAttribute(TERRAIN_DETAIL_ATTRIBUTE);
    }
    if (geometry.getAttribute(TERRAIN_GEOLOGY_ATTRIBUTE) === record.geology) {
      geometry.deleteAttribute(TERRAIN_GEOLOGY_ATTRIBUTE);
    }
    delete geometry.userData.gpuTerrainDetail;
    delete geometry.userData.gpuTerrainGeology;
    delete geometry.userData.gpuTerrainGeologyChannels;
    delete geometry.userData.gpuTerrainNeighborhoodSamples;
    delete geometry.userData.gpuTerrainComputed;
    delete geometry.userData.gpuTerrainWorkgroupSize;
    delete geometry.userData.gpuTerrainGridVertices;
    delete geometry.userData.gpuTerrainRenderVertices;
    delete geometry.userData.gpuTerrainNeutralSkirtVertices;
    delete record.mesh.userData.gpuTerrainDetail;
    this.releaseMaterial(record.material);
    record.compute.dispose();
    this.meshGeometries.delete(record.mesh);
    this.releasedCount += 1;
  }
}
