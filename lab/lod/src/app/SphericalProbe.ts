import * as THREE from 'three/webgpu';
import type { Vec3 } from '../lod/Vec3';

export type ProbeAxis = 'r' | 'theta' | 'phi';

/** θ is polar angle from +Y; φ is azimuth from +X toward +Z. */
export interface SphericalCoordinates {
  readonly r: number;
  readonly theta: number;
  readonly phi: number;
}

export interface ProbeDrag {
  readonly axis: ProbeAxis;
  readonly start: SphericalCoordinates;
  readonly clientX: number;
  readonly clientY: number;
  readonly screenUnitX: number;
  readonly screenUnitY: number;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const COLORS: Record<ProbeAxis, number> = { r: 0xff5574, theta: 0x58d8ff, phi: 0xffd65e };

/** Visible, draggable spherical-coordinate transform gizmo for the LOD viewpoint. */
export class SphericalProbe {
  readonly group = new THREE.Group();
  private readonly arrows = new Map<ProbeAxis, THREE.Group>();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly hitMeshes: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private coordinates!: SphericalCoordinates;

  constructor(
    readonly planetRadiusMeters: number,
    private readonly metersPerRenderUnit: number,
    initial: SphericalCoordinates,
  ) {
    this.set(initial);
    this.group.name = 'LOD viewpoint probe';
    for (const axis of ['r', 'theta', 'phi'] as const) {
      const arrow = this.makeArrow(axis);
      this.arrows.set(axis, arrow);
      this.group.add(arrow);
    }
    const center = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    center.userData.axis = 'r';
    center.renderOrder = 100;
    this.meshes.push(center);
    this.group.add(center);
    const centerHit = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), this.hitMaterial());
    centerHit.userData.axis = 'r';
    this.hitMeshes.push(centerHit);
    this.group.add(centerHit);
  }

  get spherical(): SphericalCoordinates { return { ...this.coordinates }; }

  get position(): Vec3 {
    const { r, theta, phi } = this.coordinates;
    return {
      x: r * Math.sin(theta) * Math.cos(phi),
      y: r * Math.cos(theta),
      z: r * Math.sin(theta) * Math.sin(phi),
    };
  }

  set(value: SphericalCoordinates): void {
    const maxR = this.planetRadiusMeters * 30;
    if (!Number.isFinite(value.r) || value.r < 0 || value.r > maxR ||
      !Number.isFinite(value.theta) || value.theta <= 0 || value.theta >= Math.PI ||
      !Number.isFinite(value.phi)) {
      throw new Error(`SphericalProbe.ts set: invalid coordinates=${JSON.stringify(value)}; rRange=[0,${maxR}]; thetaRange=(0,${Math.PI})`);
    }
    this.coordinates = { ...value };
  }

  beginDrag(axis: ProbeAxis, clientX: number, clientY: number, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement): ProbeDrag {
    const arrow = this.arrows.get(axis);
    if (!arrow) throw new Error(`SphericalProbe.ts beginDrag: missing arrow for axis=${axis}`);
    const origin = arrow.localToWorld(new THREE.Vector3(0, 0, 0)).project(camera);
    const tip = arrow.localToWorld(new THREE.Vector3(0, 1, 0)).project(camera);
    const rect = canvas.getBoundingClientRect();
    const screenX = (tip.x - origin.x) * rect.width / 2;
    const screenY = -(tip.y - origin.y) * rect.height / 2;
    const screenLength = Math.hypot(screenX, screenY);
    if (!Number.isFinite(screenLength) || screenLength < 1) {
      throw new Error(`SphericalProbe.ts beginDrag: ${axis} arrow is edge-on to the camera; screenDirection=(${screenX},${screenY}); coordinates=${JSON.stringify(this.coordinates)}; rotate view before dragging`);
    }
    return { axis, start: this.spherical, clientX, clientY, screenUnitX: screenX / screenLength, screenUnitY: screenY / screenLength };
  }

  /** A drag uses its initial transform and axis projection for the whole gesture. */
  drag(handle: ProbeDrag, clientX: number, clientY: number): void {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      throw new Error(`SphericalProbe.ts drag: invalid pointer position; axis=${handle.axis}; x=${clientX}; y=${clientY}`);
    }
    const { r, theta, phi } = handle.start;
    const alongArrowPixels = (clientX - handle.clientX) * handle.screenUnitX +
      (clientY - handle.clientY) * handle.screenUnitY;
    if (handle.axis === 'r') {
      const metersPerPixel = Math.max(this.planetRadiusMeters * 0.00125, r * 0.002);
      this.set({ r: THREE.MathUtils.clamp(r + alongArrowPixels * metersPerPixel, 0, this.planetRadiusMeters * 30), theta, phi });
    } else if (handle.axis === 'theta') {
      this.set({ r, theta: THREE.MathUtils.clamp(theta + alongArrowPixels * 0.005, 0.001, Math.PI - 0.001), phi });
    } else {
      this.set({ r, theta, phi: THREE.MathUtils.euclideanModulo(phi + alongArrowPixels * 0.005, Math.PI * 2) });
    }
  }

  /** Keep the gizmo legible while its physical position stays in meters. */
  sync(observer: Vec3): void {
    const point = this.position;
    const { theta, phi } = this.coordinates;
    this.group.position.set(
      (point.x - observer.x) / this.metersPerRenderUnit,
      (point.y - observer.y) / this.metersPerRenderUnit,
      (point.z - observer.z) / this.metersPerRenderUnit,
    );
    // θ and φ still define the radial axis when r = 0 at the exact center.
    const radial = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    const thetaTangent = new THREE.Vector3(Math.cos(theta) * Math.cos(phi), -Math.sin(theta), Math.cos(theta) * Math.sin(phi));
    const phiTangent = new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi));
    this.arrows.get('r')!.quaternion.setFromUnitVectors(Y_AXIS, radial);
    this.arrows.get('theta')!.quaternion.setFromUnitVectors(Y_AXIS, thetaTangent);
    this.arrows.get('phi')!.quaternion.setFromUnitVectors(Y_AXIS, phiTangent);
    const distance = this.group.position.length();
    this.group.scale.setScalar(THREE.MathUtils.clamp(distance * 0.12, 0.15, this.planetRadiusMeters / this.metersPerRenderUnit * 0.18));
    this.group.updateMatrixWorld(true);
  }

  pick(clientX: number, clientY: number, canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera): ProbeAxis | undefined {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
    const hit = this.raycaster.intersectObjects(this.hitMeshes, false)[0];
    if (!hit) return undefined;
    const axis = hit.object.userData.axis;
    if (axis !== 'r' && axis !== 'theta' && axis !== 'phi') {
      throw new Error(`SphericalProbe.ts pick: hit has invalid axis=${String(axis)}; object=${hit.object.name}`);
    }
    return axis;
  }

  dispose(): void {
    const materials = new Set<THREE.Material>();
    for (const mesh of [...this.meshes, ...this.hitMeshes]) {
      mesh.geometry.dispose();
      materials.add(mesh.material as THREE.Material);
    }
    for (const material of materials) material.dispose();
  }

  private makeArrow(axis: ProbeAxis): THREE.Group {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: COLORS[axis], depthTest: false });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.66, 8), material);
    shaft.position.y = 0.38;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 12), material);
    head.position.y = 0.83;
    for (const mesh of [shaft, head]) {
      mesh.userData.axis = axis;
      mesh.renderOrder = 100;
      this.meshes.push(mesh);
      group.add(mesh);
    }
    const shaftHit = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.72, 8), this.hitMaterial());
    shaftHit.position.y = 0.45;
    const headHit = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.33, 10), this.hitMaterial());
    headHit.position.y = 0.84;
    for (const mesh of [shaftHit, headHit]) {
      mesh.userData.axis = axis;
      this.hitMeshes.push(mesh);
      group.add(mesh);
    }
    return group;
  }

  private hitMaterial(): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
  }
}
