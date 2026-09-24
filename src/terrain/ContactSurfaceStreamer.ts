import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  Vector3,
  type Material,
} from 'three';
import { float, modelWorldMatrix, positionLocal, uniform, vec3 as nodeVec3, vec4 } from 'three/tsl';
import { MeshLambertNodeMaterial, type UniformNode } from 'three/webgpu';

import { addVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../core/Vec3';
import type { PlanetField } from '../fields';
import type { CelestialLightFrame } from '../lighting';
import { SurfaceFlowNodeMaterial } from '../render/planet/PlanetarySurfaceFeatures';
import { applyPlanetWeatherToLambertMaterial, type PlanetWeatherNodes } from '../render/planet/PlanetWeatherNodes';
import { sampleSurfaceRingLighting, type PhysicalRingShadowDescriptor } from '../render/planet/RingDensity';
import {
  CONTACT_SURFACE_LIMITS,
  bodyFixedToContactLocal,
  isValidContactGeneration,
  type ContactFlowDescriptor,
  type ContactLease,
  type ContactSolidDescriptor,
  type ContactSurfaceGeneration,
} from './ContactGeometry';
import { createContactRenderMask, type ContactRenderMask } from './ContactRenderMask';
import { SurfaceContactAuthority } from './SurfaceContactAuthority';
import type { SurfaceFlowRegion } from './SurfaceFlowField';
import {
  createSurfaceFlowPalette,
  surfaceFlowCornerAcross,
  surfaceFlowTriangleColors,
  SURFACE_FLOW_APPEARANCE_POLICY,
  SURFACE_FLOW_TRIANGLE_CORNERS,
} from './SurfaceFlowAppearance';
import { TerrainJobScheduler } from './TerrainJobScheduler';
import { createSurfaceTerrainPalette } from './SurfaceTerrainPresentation';

export interface PreparedContactCollider {
  /** Installs the prepared collider synchronously in the same commit as render/depth/hazards. */
  activate(): void;
  dispose(): void;
  readonly kind?: 'cpu-triangle' | 'rapier';
}

/** Parked pads use the authority's actual radial ray/triangle collider, not Rapier or a renderer flag. */
export function prepareCpuContactCollider(generation: ContactSurfaceGeneration): PreparedContactCollider {
  if (!isValidContactGeneration(generation)) throw new RangeError('CPU contact collider requires valid shared triangles.');
  return { kind: 'cpu-triangle', activate() {}, dispose() {} };
}

/** A pending region is not an empty region: no physical hazards may be invented while it loads. */
export type ContactFlowRegionReadiness =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly region: SurfaceFlowRegion }
  | { readonly status: 'failed'; readonly reason: string };

export type ContactFlowRegionResolver = (lease: ContactLease) => ContactFlowRegionReadiness;

export interface ContactSurfaceStreamerOptions {
  scheduler?: TerrainJobScheduler;
  metersPerRenderUnit?: number;
  useWorkers?: boolean;
  /** Actor leases wait for this actual collider; parked leases may use the shared CPU triangles. */
  prepareGeneration?: (generation: ContactSurfaceGeneration) => PreparedContactCollider | Promise<PreparedContactCollider>;
  /** Product callers opt into the exact visible liquid region; standalone callers keep the pure fallback. */
  resolveFlowRegion?: ContactFlowRegionResolver;
  onCommitted?: (generation: ContactSurfaceGeneration | null, leaseId: string) => void;
}

export interface ContactPreparationFailure {
  readonly token: ContactLease['token'];
  readonly reason: string;
}

/** These resources belong to the existing planet, never to a contact lease. */
export interface ContactBodyPresentation {
  readonly weatherNodes?: PlanetWeatherNodes;
  readonly ring?: PhysicalRingShadowDescriptor;
}

export interface ContactBodyPresentationValues {
  readonly elapsedSeconds?: number;
  readonly daylight?: number;
  readonly windSpeedMetersPerSecond?: number;
  readonly celestialFrame?: CelestialLightFrame;
  readonly bodyRotationRadians?: number;
}

export interface ContactSurfaceStreamerStats {
  residentGenerations: number;
  queued: number;
  generating: number;
  pendingUploads: number;
  pendingBytes: number;
  preparingColliders: number;
  triangles: number;
  drawCalls: number;
  solidProps: number;
  flowSegments: number;
  residentBytes: number;
  discarded: number;
  lastError: string | null;
}

interface RenderGeneration {
  generation: ContactSurfaceGeneration;
  root: Group;
  mask: ContactRenderMask;
  materials: Material[];
  flowMaterials: SurfaceFlowNodeMaterial[];
  litMaterials: MeshLambertNodeMaterial[];
  ringShadow: UniformNode<'float', number>;
  weatherSource?: PlanetWeatherNodes;
  triangles: number;
  draws: number;
  collider: PreparedContactCollider;
}

interface Candidate {
  generation: ContactSurfaceGeneration;
  collider: PreparedContactCollider | null;
  failed: boolean;
}

let nextContactStreamerId = 1;

function vector(value: Readonly<Vec3>): Vector3 {
  return new Vector3(value.x, value.y, value.z);
}

function geometry(vertices: Float32Array, colors: Float32Array, indices?: Uint32Array): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute('position', new BufferAttribute(vertices, 3));
  result.setAttribute('color', new BufferAttribute(colors, 3));
  if (indices) result.setIndex(new BufferAttribute(indices, 1));
  result.computeVertexNormals();
  result.computeBoundingSphere();
  return result;
}

function appendTriangle(positions: number[], colors: number[], a: Readonly<Vec3>, b: Readonly<Vec3>, c: Readonly<Vec3>, color: readonly number[]): void {
  for (const point of [a, b, c]) {
    positions.push(point.x, point.y, point.z);
    colors.push(color[0]!, color[1]!, color[2]!);
  }
}

function solidVertex(solid: ContactSolidDescriptor, unit: Readonly<Vec3>): Vec3 {
  return addVec3(solid.centerBodyFixedMeters, addVec3(
    scaleVec3(solid.rightBodyFixed, unit.x * solid.halfExtentsMeters.x),
    addVec3(scaleVec3(solid.upBodyFixed, unit.y * solid.halfExtentsMeters.y),
      scaleVec3(solid.forwardBodyFixed, unit.z * solid.halfExtentsMeters.z)),
  ));
}

/** One merged, faceted draw uses the exact same stable OBB transforms as physics. */
function solidGeometry(generation: ContactSurfaceGeneration): BufferGeometry | null {
  if (generation.solids.length === 0) return null;
  const positions: number[] = [];
  const colors: number[] = [];
  for (const solid of generation.solids) {
    const topWidth = solid.kind === 'crystal' ? 0.12 : solid.kind === 'ridge' ? 0.69 : 0.78;
    const lower = [
      { x: -1, y: -1, z: -1 }, { x: 1, y: -1, z: -1 },
      { x: 1, y: -1, z: 1 }, { x: -1, y: -1, z: 1 },
    ];
    const upper = [
      { x: -topWidth, y: 0.77, z: -topWidth }, { x: topWidth, y: 1, z: -topWidth },
      { x: topWidth, y: 0.81, z: topWidth }, { x: -topWidth, y: 0.91, z: topWidth },
    ];
    const points = [...lower, ...upper].map((point) => bodyFixedToContactLocal(generation, solidVertex(solid, point)));
    const faces = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
    ];
    for (let face = 0; face < faces.length; face += 1) {
      const indices = faces[face]!;
      const shade = 0.78 + (face % 4) * 0.105;
      const color = solid.color.map((channel) => Math.min(1, channel * shade));
      // The unit prism list is clockwise from inside; reverse it so real
      // front-face culling cannot leave an invisible collision proxy.
      appendTriangle(positions, colors, points[indices[0]!]!, points[indices[2]!]!, points[indices[1]!]!, color);
    }
  }
  const result = geometry(new Float32Array(positions), new Float32Array(colors));
  result.userData.contactSolidIds = generation.solids.map((solid) => solid.id);
  result.userData.collisionProxy = 'same-generation-body-fixed-oriented-boxes';
  return result;
}

function flowGeometry(field: PlanetField, generation: ContactSurfaceGeneration, kind: ContactFlowDescriptor['kind']): BufferGeometry | null {
  const flows = generation.flows.filter((flow) => flow.kind === kind);
  if (flows.length === 0) return null;
  const positions: number[] = [];
  const colors: number[] = [];
  const across: number[] = [];
  const palette = createSurfaceFlowPalette(field);
  for (const flow of flows) {
    const corners = flow.cornersBodyFixedMeters.map((point) => bodyFixedToContactLocal(generation, point));
    const vertexColors = surfaceFlowTriangleColors(palette, flow);
    for (let vertex = 0; vertex < SURFACE_FLOW_TRIANGLE_CORNERS.length; vertex += 1) {
      const corner = SURFACE_FLOW_TRIANGLE_CORNERS[vertex]!;
      const point = corners[corner]!; const color = vertexColors[vertex]!;
      positions.push(point.x, point.y, point.z);
      colors.push(color[0], color[1], color[2]);
      across.push(surfaceFlowCornerAcross(corner));
    }
  }
  const result = geometry(new Float32Array(positions), new Float32Array(colors));
  result.setAttribute('flowAcross', new BufferAttribute(new Float32Array(across), 1));
  result.userData.contactFlowIds = flows.map((flow) => flow.id);
  result.userData.flowAppearancePolicy = SURFACE_FLOW_APPEARANCE_POLICY;
  return result;
}

/** Visible contact ground, prepared collider, and hazard generation commit together. */
export class ContactSurfaceStreamer {
  readonly group = new Group();
  readonly scheduler: TerrainJobScheduler;
  readonly metersPerRenderUnit: number;
  private readonly authority: SurfaceContactAuthority;
  private readonly ownsScheduler: boolean;
  private readonly ownerPrefix = `contact-surface-${nextContactStreamerId++}`;
  private readonly bodyGroups = new Map<string, Group>();
  private readonly bodyPresentations = new Map<string, ContactBodyPresentation>();
  private readonly bodyPresentationValues = new Map<string, ContactBodyPresentationValues>();
  private readonly active = new Map<string, RenderGeneration>();
  private readonly candidates = new Map<string, Candidate>();
  private readonly scheduledTokens = new Map<string, number>();
  private readonly preparationFailures = new Map<string, ContactPreparationFailure>();
  private readonly unsubscribe: () => void;
  private readonly onCommitted?: ContactSurfaceStreamerOptions['onCommitted'];
  private readonly resolveFlowRegion?: ContactFlowRegionResolver;
  private prepareGeneration?: ContactSurfaceStreamerOptions['prepareGeneration'];
  private frame = 0;
  private discarded = 0;
  private lastError: string | null = null;
  private disposed = false;

  constructor(authority: SurfaceContactAuthority, options: ContactSurfaceStreamerOptions = {}) {
    this.authority = authority;
    this.metersPerRenderUnit = Math.max(Number.EPSILON, options.metersPerRenderUnit ?? 1);
    this.ownsScheduler = options.scheduler === undefined;
    this.scheduler = options.scheduler ?? new TerrainJobScheduler({
      maxWorkers: authority.quality === 'high' ? 2 : 1,
      maxUploadsPerFrame: authority.quality === 'high' ? 2 : 1,
      useWorkers: options.useWorkers ?? true,
    });
    this.prepareGeneration = options.prepareGeneration;
    this.resolveFlowRegion = options.resolveFlowRegion;
    this.onCommitted = options.onCommitted;
    this.group.name = 'Authoritative human-scale contact surfaces';
    this.unsubscribe = authority.onGenerationChanged((generation, leaseId) => {
      if (generation === null) this.removeLease(leaseId);
    });
  }

  /** Attach this group directly beneath the matching existing body-fixed planet group. */
  getBodyGroup(bodyId: string): Group {
    let group = this.bodyGroups.get(bodyId);
    if (!group) {
      group = new Group();
      group.name = `contact-body-${bodyId}`;
      group.userData.bodyId = bodyId;
      group.userData.bodyFixed = true;
      this.bodyGroups.set(bodyId, group);
      this.group.add(group);
    }
    return group;
  }

  removeBodyGroup(bodyId: string): void {
    const group = this.bodyGroups.get(bodyId);
    // A first worker result or collider preparation may not have a render
    // group yet. Revoke its lease as well, before it can recreate a detached
    // group and publish a cutout with no visible replacement.
    for (const { lease } of this.authority.statuses) {
      if (lease.bodyId === bodyId) this.authority.releaseLease(lease.id);
    }
    group?.removeFromParent();
    this.bodyGroups.delete(bodyId);
    this.bodyPresentations.delete(bodyId);
    this.bodyPresentationValues.delete(bodyId);
  }

  /** Share the body's existing climate atlas and physical ring with every resident generation. */
  setBodyPresentation(bodyId: string, presentation: ContactBodyPresentation): void {
    this.bodyPresentations.set(bodyId, { ...presentation });
    for (const value of this.active.values()) {
      if (value.generation.bodyId !== bodyId) continue;
      this.bindBodyWeather(value, presentation.weatherNodes);
      this.applyBodyPresentation(value, this.bodyPresentationValues.get(bodyId) ?? {});
    }
  }

  setGenerationPreparer(prepare: ContactSurfaceStreamerOptions['prepareGeneration']): void {
    this.prepareGeneration = prepare;
    this.preparationFailures.clear();
  }

  /** A failure is actionable only for the exact currently requested lease generation. */
  getPreparationFailure(leaseId: string): ContactPreparationFailure | undefined {
    const failure = this.preparationFailures.get(leaseId);
    if (failure && this.authority.getLease(leaseId)?.token !== failure.token) {
      this.preparationFailures.delete(leaseId);
      return undefined;
    }
    return failure;
  }

  private recordPreparationFailure(leaseId: string, token: ContactLease['token'], error: unknown): boolean {
    if (this.disposed || this.authority.getLease(leaseId)?.token !== token) return false;
    const reason = error instanceof Error ? error.message : String(error);
    this.preparationFailures.set(leaseId, Object.freeze({ token, reason }));
    this.lastError = reason;
    return true;
  }

  update(frameKey?: number | string): ContactSurfaceStreamerStats {
    if (this.disposed) return this.stats;
    if (this.ownsScheduler) this.scheduler.beginFrame(frameKey ?? ++this.frame);
    for (const leaseId of this.preparationFailures.keys()) this.getPreparationFailure(leaseId);
    for (const lease of this.authority.getPendingLeases()) {
      if (this.scheduledTokens.get(lease.id) === lease.token || this.getPreparationFailure(lease.id)?.token === lease.token) continue;
      // Do not claim an actor collider exists before the real local physics
      // adapter has been supplied (it can initialize Rapier lazily at exit).
      if (lease.kind === 'actor' && !this.prepareGeneration) continue;
      const field = this.authority.getField(lease.bodyId);
      if (!field) continue;
      let flowRegion = this.authority.getFlowRegion(lease.bodyId);
      if (this.resolveFlowRegion) {
        try {
          // This runs during serviceReadiness even when a saved-game restore
          // has stopped both simulation clocks. A callback may queue work,
          // but it must never substitute an independently generated region.
          const readiness = this.resolveFlowRegion(lease);
          if (this.disposed || this.authority.getLease(lease.id)?.token !== lease.token) continue;
          if (readiness.status === 'pending') continue;
          if (readiness.status === 'failed') {
            this.recordPreparationFailure(lease.id, lease.token, readiness.reason);
            continue;
          }
          // A parked and actor lease share the first immutable region pinned
          // for their body. Always use the authority's returned canonical pin.
          flowRegion = this.authority.setFlowRegion(lease.bodyId, readiness.region);
        } catch (error) {
          this.recordPreparationFailure(lease.id, lease.token, error);
          continue;
        }
      }
      const owner = `${this.ownerPrefix}:${lease.id}`;
      const limits = CONTACT_SURFACE_LIMITS[this.authority.quality];
      const accepted = this.scheduler.scheduleContact(owner, { field, lease,
        options: { maxSolids: limits.maxSolids, maxFlows: limits.maxFlows,
          ...(flowRegion ? { sourceFlows: flowRegion.flows,
            sourceFlowOriginBodyFixedMeters: scaleVec3(flowRegion.centerDirection, field.radius) } : {}) } },
      lease.kind === 'actor' ? 2_000_000_000 : 1_900_000_000, {
        isCurrent: () => !this.disposed && this.authority.getLease(lease.id)?.token === lease.token,
        onGenerated: (generation) => this.prepareCandidate(generation),
        upload: (generation) => this.commitCandidate(generation, field),
        onDiscard: () => this.discardCandidate(lease.id, lease.token),
        onError: (error) => {
          this.recordPreparationFailure(lease.id, lease.token, error);
          this.discardCandidate(lease.id, lease.token);
        },
      });
      if (accepted) this.scheduledTokens.set(lease.id, lease.token);
    }
    this.scheduler.pump();
    this.scheduler.flushUploads();
    return this.stats;
  }

  private prepareCandidate(generation: ContactSurfaceGeneration): void {
    const old = this.candidates.get(generation.leaseId);
    old?.collider?.dispose();
    const candidate: Candidate = { generation, collider: null, failed: false };
    this.candidates.set(generation.leaseId, candidate);
    const lease = this.authority.getLease(generation.leaseId);
    let preparation: PreparedContactCollider | Promise<PreparedContactCollider>;
    try {
      preparation = this.prepareGeneration
        ? this.prepareGeneration(generation)
        : lease?.kind === 'parked-ship'
          ? prepareCpuContactCollider(generation)
          : Promise.reject(new Error('Actor contact needs a prepared physics collider.'));
    } catch (error) {
      this.failCandidate(candidate, error);
      return;
    }
    if ('then' in preparation) {
      void preparation.then((collider) => this.finishPreparation(candidate, collider), (error) => this.failCandidate(candidate, error));
    } else this.finishPreparation(candidate, preparation);
  }

  private finishPreparation(candidate: Candidate, collider: PreparedContactCollider): void {
    const generation = candidate.generation;
    if (this.disposed || this.candidates.get(generation.leaseId) !== candidate ||
      this.authority.getLease(generation.leaseId)?.token !== generation.token) {
      collider.dispose();
      return;
    }
    candidate.collider = collider;
  }

  private failCandidate(candidate: Candidate, error: unknown): void {
    if (this.candidates.get(candidate.generation.leaseId) !== candidate) return;
    if (!this.recordPreparationFailure(candidate.generation.leaseId, candidate.generation.token, error)) {
      this.discardCandidate(candidate.generation.leaseId, candidate.generation.token);
      return;
    }
    candidate.failed = true;
  }

  private commitCandidate(generation: ContactSurfaceGeneration, field: PlanetField): boolean {
    const candidate = this.candidates.get(generation.leaseId);
    if (!candidate || candidate.generation.id !== generation.id) return false;
    if (candidate.failed) {
      this.discardCandidate(generation.leaseId, generation.token);
      return true;
    }
    if (!candidate.collider) return false;
    if (this.authority.getLease(generation.leaseId)?.token !== generation.token) {
      this.discardCandidate(generation.leaseId, generation.token);
      return true;
    }
    const previous = this.active.get(generation.leaseId);
    const prepared = this.createRenderGeneration(generation, field, candidate.collider);
    const bodyGroup = this.getBodyGroup(generation.bodyId);
    bodyGroup.add(prepared.root);
    this.active.set(generation.leaseId, prepared);
    try {
      candidate.collider.activate();
      const committed = this.authority.commitGeneration(generation, {
        renderGenerationId: generation.id,
        colliderGenerationId: generation.id,
        hazardGenerationId: generation.id,
        opaqueDepth: true,
      });
      if (!committed) throw new Error('Contact generation became stale during atomic activation.');
    } catch (error) {
      this.disposeRenderGeneration(prepared);
      candidate.collider = null;
      if (previous) this.active.set(generation.leaseId, previous);
      else this.active.delete(generation.leaseId);
      previous?.collider.activate();
      this.failCandidate(candidate, error);
      this.candidates.delete(generation.leaseId);
      this.scheduledTokens.delete(generation.leaseId);
      return true;
    }
    this.candidates.delete(generation.leaseId);
    this.scheduledTokens.delete(generation.leaseId);
    this.preparationFailures.delete(generation.leaseId);
    if (previous) this.disposeRenderGeneration(previous);
    this.refreshOverlapMasks(generation.bodyId);
    this.onCommitted?.(generation, generation.leaseId);
    return true;
  }

  private createRenderGeneration(generation: ContactSurfaceGeneration, field: PlanetField, collider: PreparedContactCollider): RenderGeneration {
    const root = new Group();
    root.name = `contact-generation-${generation.id}`;
    root.position.copy(vector(generation.originBodyFixedMeters)).multiplyScalar(1 / this.metersPerRenderUnit);
    root.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(vector(generation.eastBodyFixed), vector(generation.upBodyFixed), vector(generation.northBodyFixed)));
    root.scale.setScalar(1 / this.metersPerRenderUnit);
    root.userData.generationId = generation.id;
    root.userData.bodyId = generation.bodyId;
    root.userData.physicalMetersPerLocalUnit = 1;
    root.userData.contactCellMeters = generation.cellMeters;
    root.userData.opaqueDepth = true;
    const mask = createContactRenderMask();
    const ownCoverage = createContactRenderMask();
    ownCoverage.set([generation], { frame: generation, metersPerLocalUnit: 1, edgeInsetMeters: 0 });
    const visibleCoverage = ownCoverage.node.not().and(mask.node);
    const palette = createSurfaceTerrainPalette(field);
    const ringShadow = uniform(0);
    const ringAlbedo = nodeVec3(float(1).sub(ringShadow.mul(0.82)));
    // Native node materials include the exact mask graph in their cache key.
    // Legacy Lambert aliases actor/parked mask uniforms and opens a real hole.
    const groundMaterial = new MeshLambertNodeMaterial({ color: '#FFFFFF', vertexColors: true, flatShading: true,
      emissive: palette.emissiveHex, emissiveIntensity: palette.emissiveIntensity,
      transparent: false, depthWrite: true, depthTest: true });
    groundMaterial.maskNode = visibleCoverage;
    groundMaterial.colorNode = ringAlbedo;
    groundMaterial.userData.contactGenerationId = generation.id;
    groundMaterial.userData.sharedCollisionTriangles = true;
    groundMaterial.userData.geologicalPalette = palette.geologicalPalette;
    groundMaterial.userData.physicalRingShadow = true;
    const ground = new Mesh(geometry(generation.vertices, generation.colors, generation.indices), groundMaterial);
    ground.geometry.userData.geologicalPalette = palette.geologicalPalette;
    ground.geometry.userData.bodyFixedSedimentaryBands = true;
    ground.geometry.userData.collisionMatchedSlopeShading = true;
    ground.name = 'Opaque shared contact triangles';
    ground.userData.contactGenerationId = generation.id;
    ground.frustumCulled = false;
    root.add(ground);
    const materials: Material[] = [groundMaterial];
    const flowMaterials: SurfaceFlowNodeMaterial[] = [];
    const litMaterials: MeshLambertNodeMaterial[] = [groundMaterial];
    let triangles = generation.indices.length / 3;
    let draws = 1;
    const props = solidGeometry(generation);
    if (props) {
      const material = new MeshLambertNodeMaterial({ color: '#FFFFFF', vertexColors: true, flatShading: true,
        emissive: field.archetype === 'frozen' ? '#1D4054' : '#21182D', emissiveIntensity: 0.18 });
      material.maskNode = visibleCoverage;
      material.colorNode = ringAlbedo;
      material.userData.physicalRingShadow = true;
      const mesh = new Mesh(props, material);
      mesh.name = 'Same-generation physical rocks and crystals';
      mesh.userData.contactGenerationId = generation.id;
      mesh.userData.contactSolidIds = generation.solids.map((solid) => solid.id);
      mesh.frustumCulled = false;
      root.add(mesh);
      materials.push(material);
      litMaterials.push(material);
      triangles += props.getAttribute('position').count / 3;
      draws += 1;
    }
    for (const kind of ['river', 'lava'] as const) {
      const buffer = flowGeometry(field, generation, kind);
      if (!buffer) continue;
      const firstFlow = generation.flows.find((flow) => flow.kind === kind)!;
      const referenceHeading = generation.flowReferenceDirections?.[kind] ?? firstFlow.headingBodyFixed;
      const heading = new Vector3(dotVec3(referenceHeading, generation.eastBodyFixed),
        dotVec3(referenceHeading, generation.upBodyFixed), dotVec3(referenceHeading, generation.northBodyFixed));
      // The group converts meters to render units; the material itself sees
      // genuine local meters, so its conversion factor must remain one.
      const material = new SurfaceFlowNodeMaterial(kind, field, field.radius, heading);
      material.flowUniforms.originAlongMeters.value = dotVec3(
        subVec3(generation.originBodyFixedMeters, generation.flowOriginBodyFixedMeters ?? generation.originBodyFixedMeters), referenceHeading,
      );
      material.maskNode = visibleCoverage;
      const mesh = new Mesh(buffer, material);
      mesh.name = `Same-generation physical ${kind}`;
      mesh.userData.contactGenerationId = generation.id;
      mesh.userData.contactFlowIds = generation.flows.filter((flow) => flow.kind === kind).map((flow) => flow.id);
      mesh.frustumCulled = false;
      root.add(mesh);
      materials.push(material);
      flowMaterials.push(material);
      triangles += buffer.getAttribute('position').count / 3;
      draws += 1;
    }
    const value: RenderGeneration = { generation, root, mask, materials, flowMaterials, litMaterials,
      ringShadow, triangles, draws, collider };
    this.bindBodyWeather(value, this.bodyPresentations.get(generation.bodyId)?.weatherNodes);
    this.applyBodyPresentation(value, this.bodyPresentationValues.get(generation.bodyId) ?? {});
    return value;
  }

  private refreshOverlapMasks(bodyId: string): void {
    // Only committed render/collider pairs participate. The authority owns the
    // resolution/kind/ID ordering, including the old lease snapshot retained
    // while a replacement is still preparing.
    const generations = this.authority.getActiveGenerations(bodyId).flatMap((generation) => {
      const value = this.active.get(generation.leaseId);
      return value?.generation === generation ? [value] : [];
    });
    for (let index = 0; index < generations.length; index += 1) {
      const current = generations[index]!;
      current.mask.set(generations.slice(0, index).map((value) => value.generation), {
        frame: current.generation, metersPerLocalUnit: 1,
      });
    }
  }

  private bindBodyWeather(value: RenderGeneration, weatherNodes: PlanetWeatherNodes | undefined): void {
    if (value.weatherSource === weatherNodes) return;
    const generation = value.generation;
    const originRadius = lengthVec3(generation.originBodyFixedMeters);
    const bodyPositionMeters = nodeVec3(vector(generation.originBodyFixedMeters))
      .add(nodeVec3(vector(generation.eastBodyFixed)).mul(positionLocal.x))
      .add(nodeVec3(vector(generation.upBodyFixed)).mul(positionLocal.y))
      .add(nodeVec3(vector(generation.northBodyFixed)).mul(positionLocal.z));
    const localRadial = positionLocal.add(nodeVec3(0, originRadius, 0));
    const bodyUpWorld = modelWorldMatrix.mul(vec4(localRadial, 0)).xyz.normalize();
    for (const material of value.litMaterials) {
      // Rebinding an existing body must not stack a second weather haze or
      // retain a disposed climate atlas. All these hooks are owned here.
      if (value.weatherSource) {
        const hooks = material as unknown as Record<string, unknown>;
        for (const key of ['setupLightingModel', 'setupOutput', 'planetWeatherTransmissionNode',
          'planetWeatherHazeFactorNode', 'planetWeatherHazeColorNode']) delete hooks[key];
      }
      if (weatherNodes) applyPlanetWeatherToLambertMaterial(material, weatherNodes, {
        bodyPositionMeters, bodyUpWorld, metersPerRenderUnit: this.metersPerRenderUnit,
      });
      material.userData.contactWeatherBodyId = weatherNodes?.field.bodyId;
      material.userData.contactWeatherFrame = weatherNodes ? 'body-fixed-from-contact-tangent' : undefined;
      material.needsUpdate = true;
    }
    value.weatherSource = weatherNodes;
  }

  private applyBodyPresentation(value: RenderGeneration, values: ContactBodyPresentationValues): void {
    const generation = value.generation;
    if (values.celestialFrame) {
      const lighting = sampleSurfaceRingLighting(scaleVec3(generation.centerDirection, generation.bodyRadiusMeters),
        values.celestialFrame, values.bodyRotationRadians ?? 0, this.bodyPresentations.get(generation.bodyId)?.ring);
      value.ringShadow.value = lighting.weightedOcclusion;
      value.root.userData.ringShadowFraction = lighting.weightedOcclusion;
      value.root.userData.celestialDaylight = lighting.daylight;
      value.root.userData.actualStellarSourceIds = values.celestialFrame.sources
        .filter((source) => source.active && source.id).map((source) => source.id);
    }
    for (const material of value.flowMaterials) {
      if (values.elapsedSeconds !== undefined) material.flowUniforms.time.value = values.elapsedSeconds;
      if (values.daylight !== undefined) material.flowUniforms.daylight.value = Math.max(0, Math.min(1, values.daylight));
      if (values.windSpeedMetersPerSecond !== undefined) material.flowUniforms.speedMetersPerSecond.value = values.windSpeedMetersPerSecond;
    }
  }

  updateBodyPresentation(bodyId: string, values: ContactBodyPresentationValues): void {
    this.bodyPresentationValues.set(bodyId, { ...this.bodyPresentationValues.get(bodyId), ...values });
    for (const value of this.active.values()) {
      if (value.generation.bodyId !== bodyId) continue;
      this.applyBodyPresentation(value, this.bodyPresentationValues.get(bodyId)!);
    }
  }

  private discardCandidate(leaseId: string, token: number): void {
    const candidate = this.candidates.get(leaseId);
    if (candidate?.generation.token === token) {
      candidate.collider?.dispose();
      this.candidates.delete(leaseId);
    }
    if (this.scheduledTokens.get(leaseId) === token) this.scheduledTokens.delete(leaseId);
    this.discarded += 1;
  }

  private disposeRenderGeneration(value: RenderGeneration): void {
    value.root.removeFromParent();
    value.root.traverse((object) => { if (object instanceof Mesh) object.geometry.dispose(); });
    for (const material of value.materials) material.dispose();
    value.collider.dispose();
  }

  private removeLease(leaseId: string): void {
    this.scheduler.cancelOwner(`${this.ownerPrefix}:${leaseId}`);
    const current = this.active.get(leaseId);
    if (current) {
      this.active.delete(leaseId);
      this.disposeRenderGeneration(current);
      this.refreshOverlapMasks(current.generation.bodyId);
    }
    const candidate = this.candidates.get(leaseId);
    candidate?.collider?.dispose();
    this.candidates.delete(leaseId);
    this.scheduledTokens.delete(leaseId);
    this.preparationFailures.delete(leaseId);
    this.onCommitted?.(null, leaseId);
  }

  get stats(): ContactSurfaceStreamerStats {
    let queued = 0; let generating = 0; let pendingUploads = 0; let pendingBytes = 0;
    let triangles = 0; let drawCalls = 0; let solidProps = 0; let flowSegments = 0; let residentBytes = 0;
    for (const status of this.authority.statuses) {
      const owner = this.scheduler.getOwnerStats(`${this.ownerPrefix}:${status.lease.id}`);
      queued += owner.queued; generating += owner.generating;
      pendingUploads += owner.pendingUploads; pendingBytes += owner.pendingBytes;
    }
    for (const value of this.active.values()) {
      triangles += value.triangles; drawCalls += value.draws;
      solidProps += value.generation.solids.length; flowSegments += value.generation.flows.length;
      residentBytes += value.generation.byteLength;
    }
    return { residentGenerations: this.active.size, queued, generating, pendingUploads, pendingBytes,
      preparingColliders: [...this.candidates.values()].filter((candidate) => !candidate.collider && !candidate.failed).length,
      triangles, drawCalls, solidProps, flowSegments, residentBytes, discarded: this.discarded, lastError: this.lastError };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const status of [...this.authority.statuses]) this.authority.releaseLease(status.lease.id);
    this.unsubscribe();
    for (const group of this.bodyGroups.values()) group.removeFromParent();
    this.bodyGroups.clear();
    this.bodyPresentations.clear();
    this.bodyPresentationValues.clear();
    if (this.ownsScheduler) this.scheduler.dispose();
  }
}
