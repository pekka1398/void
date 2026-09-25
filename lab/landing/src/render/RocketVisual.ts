import * as THREE from 'three/webgpu';
import type { BodyShape } from '../physics/ContactWorld';

export interface EngineVisual { plume: THREE.Group; light: THREE.PointLight }

/**
 * Meshes for the two-stage lab rocket, in each part's local axes (+y up, the
 * part's centre of mass at the origin), with green outlines of its colliders.
 */
export class RocketVisual {
  readonly upper = new THREE.Group();
  readonly booster = new THREE.Group();
  readonly upperEngine: EngineVisual;
  readonly boosterEngine: EngineVisual;
  private readonly colliderLines: THREE.Group[];
  private readonly colliderMaterial = new THREE.LineBasicMaterial({ color: 0x3dff6e, depthTest: true });

  constructor(upperShape: BodyShape, boosterShape: BodyShape) {
    const hullMaterial = new THREE.MeshStandardMaterial({ color: 0xece7d4, metalness: 0.3, roughness: 0.55 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x273947, metalness: 0.72, roughness: 0.34 });
    const paleTrim = new THREE.MeshStandardMaterial({ color: 0xd1d6d0, metalness: 0.55, roughness: 0.42 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x214c63, emissive: 0x0a2632, emissiveIntensity: 0.45, metalness: 0.35, roughness: 0.18 });
    const upper = this.upper;
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, 1.75, 16), hullMaterial);
    hull.position.y = 0.175;
    upper.add(hull);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.0, 16), hullMaterial);
    nose.position.y = 1.55; upper.add(nose);
    const upperSkirt = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.04, 0.28, 24), trim);
    upperSkirt.position.y = -0.57; upper.add(upperSkirt);
    const noseRim = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.08, 24), trim);
    noseRim.position.y = 1.06; upper.add(noseRim);
    for (let i = 0; i < 4; i += 1) {
      const angle = i * Math.PI / 2;
      const windowFrame = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.31, 0.035), trim);
      const windowPane = new THREE.Mesh(new THREE.BoxGeometry(0.39, 0.22, 0.045), glass);
      for (const piece of [windowFrame, windowPane]) {
        piece.position.set(Math.sin(angle) * 0.935, 0.5, Math.cos(angle) * 0.935);
        piece.rotation.y = angle;
        upper.add(piece);
      }
      windowPane.position.add(new THREE.Vector3(Math.sin(angle) * 0.025, 0, Math.cos(angle) * 0.025));
    }
    const booster = this.booster;
    const legMaterial = new THREE.MeshStandardMaterial({ color: 0x687381, metalness: 0.5 });
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      const root = new THREE.Vector3(x * 0.72, -1.25, z * 0.72);
      const foot = new THREE.Vector3(x * 1.28, -2.67, z * 1.28);
      const between = new THREE.Vector3().subVectors(foot, root);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, between.length(), 8), legMaterial);
      leg.position.copy(root).add(foot).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), between.normalize());
      leg.position.y += 1.3;
      booster.add(leg);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.42), legMaterial);
      pad.position.copy(foot); pad.position.y += 1.3; booster.add(pad);
    }
    const boosterBody = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 2.35, 16), new THREE.MeshStandardMaterial({ color: 0xd87543, metalness: 0.35, roughness: 0.6 }));
    boosterBody.position.y = 0.175;
    booster.add(boosterBody);
    for (const y of [1.23, -0.93]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(y > 0 ? 1.12 : 1.245, y > 0 ? 1.15 : 1.245, 0.1, 24), trim);
      band.position.y = y; booster.add(band);
    }
    for (let i = 0; i < 4; i += 1) {
      const angle = i * Math.PI / 2;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.75, 8), paleTrim);
      pipe.position.set(Math.sin(angle) * 1.19, -0.05, Math.cos(angle) * 1.19);
      booster.add(pipe);
    }
    this.upperEngine = addEngine(upper, -0.79, 0.43, trim);
    this.boosterEngine = addEngine(booster, -1.14, 0.58, trim);
    this.colliderLines = [shapeLines(upperShape, this.colliderMaterial), shapeLines(boosterShape, this.colliderMaterial)];
    upper.add(this.colliderLines[0]!);
    booster.add(this.colliderLines[1]!);
  }

  setColliderLines(visible: boolean): void {
    for (const lines of this.colliderLines) lines.visible = visible;
  }

  /** Plume length and engine light for a throttle of 0..1; `time` flickers the plume. */
  static fire(engine: EngineVisual, active: boolean, throttle: number, time: number): void {
    engine.plume.visible = active && throttle > 0;
    engine.plume.scale.y = 0.55 + throttle * (0.8 + 0.04 * Math.sin(time * 40));
    engine.light.intensity = active ? throttle * 8 : 0;
  }
}

function addEngine(parent: THREE.Group, nozzleY: number, radius: number, trim: THREE.Material): EngineVisual {
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius * 0.68, 0.16, 24), trim);
  mount.position.y = nozzleY + 0.18; parent.add(mount);
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius, 0.37, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x778995, metalness: 0.85, roughness: 0.28, side: THREE.DoubleSide }));
  bell.position.y = nozzleY - 0.07; parent.add(bell);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.045, 8, 24), trim);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = nozzleY - 0.255; parent.add(lip);
  const plume = new THREE.Group();
  plume.position.y = nozzleY - 0.28;
  const outer = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.9, 2.8, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff8c43, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  outer.rotation.z = Math.PI;
  outer.position.y = -1.4;
  const core = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.48, 1.9, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xbcefff, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  core.rotation.z = Math.PI;
  core.position.y = -0.95;
  plume.add(outer, core);
  plume.visible = false;
  parent.add(plume);
  const light = new THREE.PointLight(0xffb66d, 0, 16);
  light.position.y = nozzleY - 0.45; parent.add(light);
  return { plume, light };
}

function shapeLines(shape: BodyShape, material: THREE.LineBasicMaterial): THREE.Group {
  const group = new THREE.Group();
  const pieces = shape.kind === 'compound' ? shape.parts : [{ shape, position: { x: 0, y: 0, z: 0 } }];
  for (const piece of pieces) {
    const s = piece.shape;
    const geometry = s.kind === 'box' ? new THREE.BoxGeometry(2 * s.halfExtents.x, 2 * s.halfExtents.y, 2 * s.halfExtents.z)
      : s.kind === 'ball' ? new THREE.SphereGeometry(s.radius, 12, 8)
      : s.kind === 'cone' ? new THREE.ConeGeometry(s.radius, 2 * s.halfHeight, 12)
      : new THREE.CylinderGeometry(s.radius, s.radius, 2 * s.halfHeight, 12);
    const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), material);
    lines.position.set(piece.position.x, piece.position.y, piece.position.z);
    if ('rotation' in piece && piece.rotation) lines.quaternion.set(piece.rotation.x, piece.rotation.y, piece.rotation.z, piece.rotation.w);
    lines.renderOrder = 2;
    group.add(lines);
  }
  return group;
}
