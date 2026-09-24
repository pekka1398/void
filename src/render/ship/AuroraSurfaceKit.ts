import manifest from './aurora-surface-kit-v1.asset.json';
import type * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Vec3 } from '../../core';
import { AURORA_ACTIVE_ASSET, AURORA_PHYSICAL_METERS_PER_GLTF_UNIT } from './AuroraAsset';

export interface AuroraSurfaceQuaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface AuroraSurfaceBounds {
  readonly min: Readonly<Vec3>;
  readonly max: Readonly<Vec3>;
}

export interface AuroraSurfaceTransform {
  /** Local to parentNodeName, in native +Y-up / -Z-forward GLB meters. */
  readonly positionMeters: Readonly<Vec3>;
  readonly rotationQuaternion: AuroraSurfaceQuaternion;
  readonly scale: Readonly<Vec3>;
}

export interface AuroraSurfaceArticulation {
  readonly id: string;
  readonly nodeName: string;
  readonly parentNodeName: string;
  readonly stowed: AuroraSurfaceTransform;
  readonly deployed: AuroraSurfaceTransform;
}

export interface AuroraLandingPad {
  readonly id: string;
  readonly nodeName: string;
  /** Center of the actual fully deployed pad's ground-contact face. */
  readonly positionMeters: Readonly<Vec3>;
  readonly radiusMeters: number;
}

export interface AuroraLiftThrusterSocket {
  readonly id: string;
  readonly nodeName: string;
  readonly positionMeters: Readonly<Vec3>;
  readonly direction: Readonly<Vec3>;
  readonly radiusMeters: number;
}

export interface AuroraSurfaceCollisionBox {
  readonly id: string;
  readonly nodeName: string;
  readonly kind: 'pressure-body' | 'canopy' | 'wing' | 'engine' | 'fin' | 'gear';
  readonly centerMeters: Readonly<Vec3>;
  readonly halfExtentsMeters: Readonly<Vec3>;
}

export interface AuroraSurfaceEgressPoint {
  /** Camera eye, not capsule center or foot position. */
  readonly positionMeters: Readonly<Vec3>;
  /** The static hull has no traversable cabin; only exterior points are swept. */
  readonly stage: 'interior-fade' | 'exterior';
}

/** Serializable physical contract. Simulation imports do not load Three/GLTF. */
export interface AuroraSurfaceKitManifest {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly surfaceKitVersion: 1;
  readonly physicalMetersPerGltfUnit: 1;
  readonly hullAssetId: string;
  readonly hullSha256: string;
  readonly rootNodeName: string;
  readonly collisionRootNodeName: string;
  readonly physicalBoundsMeters: AuroraSurfaceBounds;
  readonly landingPadsMeters: readonly AuroraLandingPad[];
  readonly liftThrusterSocketsMeters: readonly AuroraLiftThrusterSocket[];
  readonly gearTransforms: readonly AuroraSurfaceArticulation[];
  readonly rampTransforms: readonly AuroraSurfaceArticulation[];
  readonly pilotEyeMeters: Readonly<Vec3>;
  readonly egressRailMeters: readonly AuroraSurfaceEgressPoint[];
  readonly rampFootMeters: Readonly<Vec3>;
  readonly rampFootNodeName: string;
  /** Dry standing point beyond the actual ramp toe, clear of the ship capsule. */
  readonly egressStandMeters: Readonly<Vec3>;
  readonly egressStandNodeName: string;
  readonly rampSurfaceMeters: {
    /** The real board's upper supporting plane, not its lower ground-contact toe. */
    readonly startMeters: Readonly<Vec3>;
    readonly endMeters: Readonly<Vec3>;
    readonly widthMeters: number;
    readonly thicknessMeters: number;
  };
  readonly boardingVolumeMeters: {
    readonly centerMeters: Readonly<Vec3>;
    readonly halfExtentsMeters: Readonly<Vec3>;
  };
  readonly collisionProxyMeters: readonly AuroraSurfaceCollisionBox[];
  readonly minimumBellyClearanceMeters: number;
  readonly maximumLandingSlopeDegrees: number;
  readonly maximumPadHeightSpreadMeters: number;
  readonly sha256: string;
  readonly byteLength: number;
  /** Visible geometry only; the separately removed collision meshes are below. */
  readonly triangleCount: number;
  readonly collisionTriangleCount: number;
  readonly materialCount: number;
  readonly opaqueDrawCount: number;
  readonly stowedBoundsMeters: AuroraSurfaceBounds;
  readonly deployedBoundsMeters: AuroraSurfaceBounds;
}

export interface AuroraSurfaceKitVisual {
  /** Native metric asset root. The owner applies the physical world scale. */
  readonly group: THREE.Group;
  readonly manifest: AuroraSurfaceKitManifest;
  setDeployment(gearProgress: number, rampProgress: number): void;
  dispose(): void;
}

export interface AuroraSurfaceKitLoadOptions {
  readonly url?: string;
  readonly quality?: 'high' | 'fallback';
  readonly loader?: Pick<GLTFLoader, 'parseAsync'>;
  readonly fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
  readonly onError?: (error: Error) => void;
}

/** Authored data is useful for planning; availability requires a valid loaded GLB. */
export const AURORA_SURFACE_KIT_ASSET: Readonly<AuroraSurfaceKitManifest> = deepFreeze(
  manifest as unknown as AuroraSurfaceKitManifest,
);

const POSITION_TOLERANCE = 0.0002;

/** Strict, renderer-independent rejection of incomplete or incompatible data. */
export function validateAuroraSurfaceKitManifest(value: unknown): value is AuroraSurfaceKitManifest {
  return getAuroraSurfaceKitValidationErrors(value).length === 0;
}

export function getAuroraSurfaceKitValidationErrors(value: unknown): readonly string[] {
  const errors: string[] = [];
  if (!record(value)) return ['Surface kit manifest is not an object.'];
  const data = value as unknown as AuroraSurfaceKitManifest;
  const require = (condition: unknown, message: string): void => {
    if (!condition) errors.push(message);
  };
  require(data.id === 'aurora-surface-kit-v1' && data.surfaceKitVersion === 1,
    'Unsupported surface kit identity or version.');
  require(data.physicalMetersPerGltfUnit === AURORA_PHYSICAL_METERS_PER_GLTF_UNIT,
    'Surface kit does not use native physical meters.');
  require(data.hullAssetId === AURORA_ACTIVE_ASSET.id && data.hullSha256 === AURORA_ACTIVE_ASSET.sha256,
    'Surface kit is not bound to the approved active airframe.');
  require(typeof data.url === 'string' && data.url.startsWith('/models/'), 'Invalid surface kit URL.');
  require(typeof data.sha256 === 'string' && /^[a-f0-9]{64}$/.test(data.sha256),
    'Missing authenticated surface kit bytes.');
  require(integerIn(data.byteLength, 1, 2_000_000), 'Invalid surface kit byte budget.');
  require(integerIn(data.triangleCount, 1, 3_500), 'Invalid visible surface kit triangle budget.');
  require(integerIn(data.collisionTriangleCount, 12, 2_400), 'Invalid collision geometry budget.');
  require(integerIn(data.materialCount, 1, 4), 'Invalid surface kit material budget.');
  require(integerIn(data.opaqueDrawCount, 1, 10), 'Invalid surface kit draw budget.');
  require(validBounds(data.physicalBoundsMeters), 'Invalid physical hull bounds.');
  require(validBounds(data.stowedBoundsMeters) && validBounds(data.deployedBoundsMeters),
    'Invalid authored deployment bounds.');
  if (validBounds(data.physicalBoundsMeters) && AURORA_ACTIVE_ASSET.geometry) {
    require(closeVec(data.physicalBoundsMeters.min, AURORA_ACTIVE_ASSET.geometry.bounds.min) &&
      closeVec(data.physicalBoundsMeters.max, AURORA_ACTIVE_ASSET.geometry.bounds.max),
    'Physical bounds do not match the approved hull.');
  }

  const pads = Array.isArray(data.landingPadsMeters) ? data.landingPadsMeters : [];
  require(pads.length === 3 && unique(pads.map((pad) => pad?.id)), 'Expected three distinct landing pads.');
  require(unique(pads.map((pad) => pad?.nodeName)), 'Landing-pad sockets must be distinct.');
  require(pads.every((pad) => record(pad) && validVec(pad.positionMeters) &&
    nonempty(pad.nodeName) && finiteIn(pad.radiusMeters, .2, .7)), 'Invalid landing pad measurement.');
  if (pads.length === 3 && pads.every((pad) => validVec(pad?.positionMeters))) {
    const [a, b, c] = pads.map((pad) => pad.positionMeters) as [Vec3, Vec3, Vec3];
    const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    require(Math.abs(area) > 8, 'Landing pad support polygon is degenerate.');
    require(Math.max(...pads.map((pad) => pad.positionMeters.y)) -
      Math.min(...pads.map((pad) => pad.positionMeters.y)) < POSITION_TOLERANCE,
    'Authored deployed landing pads do not share a contact plane.');
  }

  const lifts = Array.isArray(data.liftThrusterSocketsMeters) ? data.liftThrusterSocketsMeters : [];
  require(lifts.length === 4 && unique(lifts.map((socket) => socket?.id)),
    'Expected four distinct physical lift sockets.');
  require(unique(lifts.map((socket) => socket?.nodeName)), 'Lift sockets must be distinct.');
  require(lifts.every((socket) => record(socket) && validVec(socket.positionMeters) &&
    closeVec(socket.direction, { x: 0, y: -1, z: 0 }) &&
    nonempty(socket.nodeName) && finiteIn(socket.radiusMeters, .1, .6)), 'Invalid lift socket.');

  const gears = Array.isArray(data.gearTransforms) ? data.gearTransforms : [];
  const ramps = Array.isArray(data.rampTransforms) ? data.rampTransforms : [];
  const articulations = [...gears, ...ramps];
  require(gears.length === 6 && ramps.length === 1, 'Incomplete folding gear/ramp transforms.');
  require(unique(articulations.map((part) => part?.nodeName)) &&
    articulations.every((part) => record(part) && nonempty(part.id) && nonempty(part.nodeName) &&
      nonempty(part.parentNodeName) && validTransform(part.stowed) && validTransform(part.deployed)),
  'Invalid named surface articulation.');
  require(nonempty(data.rootNodeName) && nonempty(data.collisionRootNodeName), 'Missing authored root nodes.');

  const rail = Array.isArray(data.egressRailMeters) ? data.egressRailMeters : [];
  require(validVec(data.pilotEyeMeters) && validVec(data.rampFootMeters) && validVec(data.egressStandMeters),
    'Invalid pilot/ramp/standing position.');
  require(nonempty(data.rampFootNodeName) && nonempty(data.egressStandNodeName),
    'Missing physical ramp/standing sockets.');
  if (validVec(data.rampFootMeters) && validVec(data.egressStandMeters)) {
    require(data.egressStandMeters.z - data.rampFootMeters.z >= .4 &&
      Math.abs(data.egressStandMeters.y - data.rampFootMeters.y) < POSITION_TOLERANCE,
    'Standing point does not safely clear the actual ramp toe.');
  }
  require(rail.length >= 3 && rail.length <= 8 && rail.every((point) =>
    record(point) && validVec(point.positionMeters) &&
    (point.stage === 'interior-fade' || point.stage === 'exterior')), 'Invalid authored egress rail.');
  const exterior = rail.findIndex((point) => point?.stage === 'exterior');
  require(exterior >= 1 && exterior < rail.length - 1 &&
    rail.slice(exterior).every((point) => point.stage === 'exterior'),
  'Egress must have an explicit post-fade exterior segment.');
  if (validVec(data.pilotEyeMeters) && rail.length) {
    require(closeVec(rail[0]?.positionMeters, data.pilotEyeMeters), 'Egress does not start at the real pilot eye.');
  }
  if (validVec(data.egressStandMeters) && rail.length) {
    require(closeVec(rail.at(-1)?.positionMeters,
      { x: data.egressStandMeters.x, y: data.egressStandMeters.y + 1.7, z: data.egressStandMeters.z }),
    'Egress does not end at the human-scale standing point.');
  }
  require(record(data.boardingVolumeMeters) && validVec(data.boardingVolumeMeters.centerMeters) &&
    positiveVec(data.boardingVolumeMeters.halfExtentsMeters), 'Invalid boarding volume.');
  require(record(data.rampSurfaceMeters) && validVec(data.rampSurfaceMeters.startMeters) &&
    validVec(data.rampSurfaceMeters.endMeters) &&
    finiteIn(data.rampSurfaceMeters.widthMeters, .8, 1.8) &&
    finiteIn(data.rampSurfaceMeters.thicknessMeters, .04, .25), 'Invalid physical ramp surface.');

  const proxies = Array.isArray(data.collisionProxyMeters) ? data.collisionProxyMeters : [];
  const kinds = new Set(['pressure-body', 'canopy', 'wing', 'engine', 'fin', 'gear']);
  require(proxies.length >= 8 && proxies.length <= 128 && unique(proxies.map((proxy) => proxy?.id)),
    'Missing bounded collision proxy pieces.');
  require(unique(proxies.map((proxy) => proxy?.nodeName)), 'Collision proxy nodes must be distinct.');
  require(proxies.every((proxy) => record(proxy) && nonempty(proxy.nodeName) &&
    validVec(proxy.centerMeters) && positiveVec(proxy.halfExtentsMeters) &&
    typeof proxy.kind === 'string' && kinds.has(proxy.kind)),
  'Invalid physical collision proxy.');
  require(data.collisionTriangleCount === proxies.length * 12,
    'Collision box geometry does not match the manifest.');
  require(finiteIn(data.minimumBellyClearanceMeters, .75, 2.5) &&
    finiteIn(data.maximumLandingSlopeDegrees, 1, 30) &&
    finiteIn(data.maximumPadHeightSpreadMeters, .05, 1), 'Invalid landing clearance limits.');
  return errors;
}

/**
 * Authenticate the actual asset, pivots, deployed sockets, bounds, and hidden
 * collider meshes before enabling surface travel. No guessed fallback kit.
 */
export async function loadAuroraSurfaceKit(
  options: AuroraSurfaceKitLoadOptions = {},
): Promise<AuroraSurfaceKitVisual | null> {
  let scene: THREE.Group | undefined;
  try {
    const data = AURORA_SURFACE_KIT_ASSET;
    const errors = getAuroraSurfaceKitValidationErrors(data);
    if (errors.length) throw new Error(errors.join(' '));
    const url = options.url ?? data.url;
    const bytes = await (options.fetchArrayBuffer ?? fetchKitBytes)(url);
    if (bytes.byteLength !== data.byteLength || await sha256(bytes) !== data.sha256) {
      throw new Error('The downloaded AURORA surface kit is not the validated authored asset.');
    }

    const Three = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { normalizeAuroraMaterials } = await import('./AuroraMaterials');
    const asset: GLTF = await (options.loader ?? new GLTFLoader()).parseAsync(bytes, '');
    if (!(asset.scene instanceof Three.Group)) throw new Error('Surface kit GLB has no scene.');
    scene = asset.scene;
    scene.name = 'AURORA / validated metric surface kit';

    const names = new Map<string, THREE.Object3D>();
    scene.traverse((object) => {
      if (!object.name) return;
      if (names.has(object.name)) throw new Error(`Duplicate surface kit node ${object.name}.`);
      names.set(object.name, object);
    });
    const required = (name: string): THREE.Object3D => {
      const object = names.get(name);
      if (!object) throw new Error(`Missing authored surface kit node ${name}.`);
      return object;
    };
    const root = required(data.rootNodeName);
    if (!closeVec(root.position, { x: 0, y: 0, z: 0 }) || !unitScale(root.scale) ||
      !closeQuat(root.quaternion, { x: 0, y: 0, z: 0, w: 1 })) {
      throw new Error('Surface kit root is not in the native meter frame.');
    }

    const parts = [...data.gearTransforms, ...data.rampTransforms].map((part) => {
      const node = required(part.nodeName);
      if (node.parent?.name !== part.parentNodeName || !matchesTransform(node, part.stowed)) {
        throw new Error(`Surface articulation ${part.nodeName} disagrees with its authenticated stowed transform.`);
      }
      return { definition: part, node,
        stowedPosition: new Three.Vector3().copy(part.stowed.positionMeters),
        deployedPosition: new Three.Vector3().copy(part.deployed.positionMeters),
        stowedRotation: new Three.Quaternion().copy(part.stowed.rotationQuaternion),
        deployedRotation: new Three.Quaternion().copy(part.deployed.rotationQuaternion),
      };
    });

    const collisionRoot = required(data.collisionRootNodeName);
    scene.updateMatrixWorld(true);
    for (const proxy of data.collisionProxyMeters) {
      const node = required(proxy.nodeName);
      if (!(node instanceof Three.Mesh) || node.parent !== collisionRoot) {
        throw new Error(`Missing actual collision geometry ${proxy.nodeName}.`);
      }
      const bounds = new Three.Box3().setFromObject(node);
      const center = bounds.getCenter(new Three.Vector3());
      const half = bounds.getSize(new Three.Vector3()).multiplyScalar(.5);
      if (!closeVec(center, proxy.centerMeters) || !closeVec(half, proxy.halfExtentsMeters) ||
        (node.geometry.index?.count ?? 0) !== 36) {
        throw new Error(`Collision geometry ${proxy.nodeName} does not match its physical box.`);
      }
    }
    collisionRoot.removeFromParent();
    disposeObject(collisionRoot);

    const setDeployment = (gearProgress: number, rampProgress: number): void => {
      const gear = deploymentProgress(gearProgress);
      const ramp = deploymentProgress(rampProgress);
      for (const part of parts) {
        const progress = part.definition.id === 'aft-ramp' ? ramp : gear;
        part.node.position.lerpVectors(part.stowedPosition, part.deployedPosition, progress);
        part.node.quaternion.slerpQuaternions(part.stowedRotation, part.deployedRotation, progress);
        part.node.scale.set(1, 1, 1);
      }
      scene!.updateMatrixWorld(true);
      scene!.userData.gearProgress = gear;
      scene!.userData.rampProgress = ramp;
    };

    if (!matchesGeometryBounds(scene, data.stowedBoundsMeters)) {
      throw new Error('Actual stowed surface geometry does not match the manifest.');
    }
    setDeployment(1, 1);
    for (const point of [...data.landingPadsMeters, ...data.liftThrusterSocketsMeters,
      { nodeName: data.rampFootNodeName, positionMeters: data.rampFootMeters },
      { nodeName: data.egressStandNodeName, positionMeters: data.egressStandMeters }]) {
      const actual = required(point.nodeName).getWorldPosition(new Three.Vector3());
      if (!closeVec(actual, point.positionMeters)) {
        throw new Error(`Actual deployed surface socket ${point.nodeName} has moved.`);
      }
    }
    if (!matchesGeometryBounds(scene, data.deployedBoundsMeters)) {
      throw new Error('Actual deployed surface geometry does not match the manifest.');
    }
    setDeployment(0, 0);

    let triangles = 0;
    let draws = 0;
    const originals = new Set<THREE.Material>();
    scene.traverse((object) => {
      if (!(object instanceof Three.Mesh)) return;
      if (!object.geometry.hasAttribute('position') || !object.geometry.hasAttribute('normal') ||
        !object.geometry.hasAttribute('color') || !object.geometry.index) {
        throw new Error(`Surface mesh ${object.name} lacks authored indexed attributes.`);
      }
      triangles += object.geometry.index.count / 3;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      draws += Array.isArray(object.material) ? object.geometry.groups.length : 1;
      for (const material of materials) originals.add(material);
      object.frustumCulled = false;
    });
    if (triangles !== data.triangleCount || draws !== data.opaqueDrawCount ||
      originals.size !== data.materialCount) {
      throw new Error('Actual visible surface-kit geometry exceeds or disagrees with the manifest.');
    }
    normalizeAuroraMaterials(scene, options.quality ?? 'high', { preserveAuthoredAppearance: true });
    for (const material of originals) material.dispose();
    scene.userData.surfaceKitValidated = true;
    scene.userData.surfaceKitVersion = data.surfaceKitVersion;
    scene.userData.physicalMetersPerGltfUnit = data.physicalMetersPerGltfUnit;
    scene.userData.assetSha256 = data.sha256;
    scene.userData.opaqueDrawCount = draws;
    scene.userData.triangleCount = triangles;

    const loaded = scene;
    let disposed = false;
    return {
      group: loaded,
      manifest: data,
      setDeployment(gearProgress, rampProgress) {
        if (!disposed) setDeployment(gearProgress, rampProgress);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        loaded.removeFromParent();
        disposeObject(loaded);
      },
    };
  } catch (cause) {
    if (scene) disposeObject(scene);
    const error = cause instanceof Error ? cause : new Error(String(cause));
    options.onError?.(error);
    console.warn('AURORA surface kit unavailable; landing and egress remain disabled.', error);
    return null;
  }
}

function matchesTransform(node: THREE.Object3D, transform: AuroraSurfaceTransform): boolean {
  return closeVec(node.position, transform.positionMeters) && unitScale(node.scale) &&
    closeQuat(node.quaternion, transform.rotationQuaternion);
}

function matchesGeometryBounds(root: THREE.Object3D, expected: AuroraSurfaceBounds): boolean {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    const elements = mesh.matrixWorld.elements;
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      const px = elements[0]! * x + elements[4]! * y + elements[8]! * z + elements[12]!;
      const py = elements[1]! * x + elements[5]! * y + elements[9]! * z + elements[13]!;
      const pz = elements[2]! * x + elements[6]! * y + elements[10]! * z + elements[14]!;
      min.x = Math.min(min.x, px); min.y = Math.min(min.y, py); min.z = Math.min(min.z, pz);
      max.x = Math.max(max.x, px); max.y = Math.max(max.y, py); max.z = Math.max(max.z, pz);
    }
  });
  return closeVec(min, expected.min) && closeVec(max, expected.max);
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

async function fetchKitBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Surface kit request failed (${response.status}).`);
  return response.arrayBuffer();
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deploymentProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return finiteIn(value, minimum, maximum) && Number.isInteger(value);
}

function unique(values: readonly unknown[]): boolean {
  return values.every(nonempty) && new Set(values).size === values.length;
}

function validVec(value: unknown): value is Vec3 {
  return record(value) && typeof value.x === 'number' && Number.isFinite(value.x) &&
    typeof value.y === 'number' && Number.isFinite(value.y) &&
    typeof value.z === 'number' && Number.isFinite(value.z);
}

function positiveVec(value: unknown): value is Vec3 {
  return validVec(value) && value.x > 0 && value.y > 0 && value.z > 0;
}

function closeVec(first: unknown, second: unknown): boolean {
  return validVec(first) && validVec(second) && Math.abs(first.x - second.x) < POSITION_TOLERANCE &&
    Math.abs(first.y - second.y) < POSITION_TOLERANCE && Math.abs(first.z - second.z) < POSITION_TOLERANCE;
}

function unitScale(value: unknown): boolean {
  return closeVec(value, { x: 1, y: 1, z: 1 });
}

function validQuat(value: unknown): value is AuroraSurfaceQuaternion {
  return validVec(value) && record(value) && typeof value.w === 'number' && Number.isFinite(value.w) &&
    Math.abs(Math.hypot(value.x, value.y, value.z, value.w) - 1) < .0001;
}

function closeQuat(first: unknown, second: unknown): boolean {
  if (!validQuat(first) || !validQuat(second)) return false;
  // q and -q represent the same rotation.
  const sign = first.x * second.x + first.y * second.y + first.z * second.z + first.w * second.w < 0 ? -1 : 1;
  return Math.abs(first.x - second.x * sign) < POSITION_TOLERANCE &&
    Math.abs(first.y - second.y * sign) < POSITION_TOLERANCE &&
    Math.abs(first.z - second.z * sign) < POSITION_TOLERANCE &&
    Math.abs(first.w - second.w * sign) < POSITION_TOLERANCE;
}

function validBounds(value: unknown): value is AuroraSurfaceBounds {
  return record(value) && validVec(value.min) && validVec(value.max) &&
    value.min.x < value.max.x && value.min.y < value.max.y && value.min.z < value.max.z;
}

function validTransform(value: unknown): value is AuroraSurfaceTransform {
  return record(value) && validVec(value.positionMeters) && validQuat(value.rotationQuaternion) && unitScale(value.scale);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
