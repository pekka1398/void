import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';

const FRAME_DEPTH_METERS = 1.36;
const CLEAR_WINDSHIELD_FRACTION = 0.74;

type FramePoint = readonly [x: number, y: number, z?: number];

interface FrameSegment {
  readonly start: FramePoint;
  readonly end: FramePoint;
  readonly width: number;
  readonly depth: number;
  readonly brightness?: number;
}

interface FrameAppearance {
  readonly name: string;
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly emissiveIntensity?: number;
  readonly segments: readonly FrameSegment[];
}

const AURORA_FRAME_APPEARANCES: readonly FrameAppearance[] = [
  {
    name: 'AURORA / faceted indigo canopy arch and paired A-pillars',
    color: 0x26305d,
    roughness: 0.43,
    metalness: 0.22,
    segments: [
      { start: [-0.98, -0.91, 0.09], end: [-0.89, -0.45, 0.025], width: 0.11, depth: 0.14 },
      { start: [-0.89, -0.45, 0.025], end: [-0.855, 0.68, -0.045], width: 0.08, depth: 0.12 },
      { start: [-0.855, 0.68, -0.045], end: [-0.75, 0.88, -0.075], width: 0.085, depth: 0.13 },
      { start: [0.98, -0.91, 0.09], end: [0.89, -0.45, 0.025], width: 0.11, depth: 0.14 },
      { start: [0.89, -0.45, 0.025], end: [0.855, 0.68, -0.045], width: 0.08, depth: 0.12 },
      { start: [0.855, 0.68, -0.045], end: [0.75, 0.88, -0.075], width: 0.085, depth: 0.13 },
      { start: [-0.765, 0.87, -0.065], end: [-0.4, 0.92, -0.085], width: 0.095, depth: 0.14 },
      { start: [-0.4, 0.9, -0.085], end: [0.4, 0.9, -0.095], width: 0.095, depth: 0.15 },
      { start: [0.4, 0.92, -0.095], end: [0.765, 0.87, -0.065], width: 0.095, depth: 0.14 },
      { start: [-1.15, -0.97, 0.1], end: [1.15, -0.97, 0.1], width: 0.22, depth: 0.18 },
      { start: [-0.91, -0.87, 0.065], end: [-0.5, -0.765, 0.045], width: 0.1, depth: 0.13 },
      { start: [0.91, -0.87, 0.065], end: [0.5, -0.765, 0.045], width: 0.1, depth: 0.13 },
      { start: [-0.51, -0.795, 0.045], end: [0.51, -0.795, 0.045], width: 0.105, depth: 0.14 },
      { start: [-0.26, -0.795, 0.055], end: [-0.15, -0.68, 0.025], width: 0.068, depth: 0.105 },
      { start: [0.26, -0.795, 0.055], end: [0.15, -0.68, 0.025], width: 0.068, depth: 0.105 },
      { start: [-0.16, -0.68, 0.025], end: [0.16, -0.68, 0.025], width: 0.067, depth: 0.105 },
    ],
  },
  {
    name: 'AURORA / graphite instrument cowling and inner canopy shoulders',
    color: 0x101a30,
    roughness: 0.53,
    metalness: 0.2,
    segments: [
      { start: [-1.08, -0.93, 0.155], end: [-0.46, -0.93, 0.135], width: 0.15, depth: 0.11 },
      { start: [0.46, -0.93, 0.135], end: [1.08, -0.93, 0.155], width: 0.15, depth: 0.11 },
      { start: [-0.52, -0.91, 0.16], end: [0.52, -0.91, 0.16], width: 0.18, depth: 0.12 },
      { start: [-0.96, -0.72, 0.1], end: [-0.91, -0.34, 0.055], width: 0.065, depth: 0.08 },
      { start: [0.96, -0.72, 0.1], end: [0.91, -0.34, 0.055], width: 0.065, depth: 0.08 },
      { start: [-0.22, 0.93, -0.025], end: [0.22, 0.93, -0.025], width: 0.065, depth: 0.08 },
      { start: [-0.12, -0.74, 0.105], end: [0.12, -0.74, 0.105], width: 0.07, depth: 0.085 },
    ],
  },
  {
    name: 'AURORA / restrained ivory-titanium canopy seam',
    color: 0xd1cbc1,
    roughness: 0.39,
    metalness: 0.34,
    segments: [
      { start: [-0.796, -0.26, 0.032], end: [-0.775, 0.39, -0.035], width: 0.012, depth: 0.024 },
      { start: [0.796, -0.26, 0.032], end: [0.775, 0.39, -0.035], width: 0.012, depth: 0.024 },
      { start: [-0.666, 0.772, -0.055], end: [-0.39, 0.84, -0.065], width: 0.014, depth: 0.025 },
      { start: [-0.39, 0.84, -0.065], end: [0.39, 0.84, -0.072], width: 0.012, depth: 0.025 },
      { start: [0.39, 0.84, -0.072], end: [0.666, 0.772, -0.055], width: 0.014, depth: 0.025 },
      { start: [-0.89, -0.816, 0.114], end: [-0.52, -0.724, 0.095], width: 0.012, depth: 0.023 },
      { start: [0.52, -0.724, 0.095], end: [0.89, -0.816, 0.114], width: 0.012, depth: 0.023 },
    ],
  },
  {
    name: 'AURORA / physically illuminated cyan cockpit guidance rails',
    color: 0x00dff1,
    roughness: 0.3,
    metalness: 0.04,
    emissiveIntensity: 1.68,
    segments: [
      { start: [-0.833, -0.69, 0.135], end: [-0.585, -0.628, 0.115], width: 0.014, depth: 0.022 },
      { start: [0.585, -0.628, 0.115], end: [0.833, -0.69, 0.135], width: 0.014, depth: 0.022 },
      { start: [-0.827, 0.025, 0.012], end: [-0.814, 0.235, -0.007], width: 0.009, depth: 0.018 },
      { start: [0.827, 0.025, 0.012], end: [0.814, 0.235, -0.007], width: 0.009, depth: 0.018 },
      { start: [-0.092, -0.642, 0.082], end: [-0.035, -0.642, 0.082], width: 0.009, depth: 0.018 },
      { start: [0.035, -0.642, 0.082], end: [0.092, -0.642, 0.082], width: 0.009, depth: 0.018 },
    ],
  },
  {
    name: 'AURORA / authentic amber cockpit instrument annunciators',
    color: 0xffad57,
    roughness: 0.32,
    metalness: 0.035,
    emissiveIntensity: 1.12,
    segments: [
      { start: [-0.716, -0.754, 0.16], end: [-0.657, -0.74, 0.16], width: 0.014, depth: 0.021 },
      { start: [0.657, -0.74, 0.16], end: [0.716, -0.754, 0.16], width: 0.014, depth: 0.021 },
      { start: [-0.117, 0.897, 0.015], end: [-0.075, 0.897, 0.015], width: 0.011, depth: 0.019 },
      { start: [-0.047, 0.897, 0.015], end: [-0.018, 0.897, 0.015], width: 0.011, depth: 0.019 },
      { start: [0.018, 0.897, 0.015], end: [0.047, 0.897, 0.015], width: 0.011, depth: 0.019 },
      { start: [0.075, 0.897, 0.015], end: [0.117, 0.897, 0.015], width: 0.011, depth: 0.019 },
    ],
  },
];

function createFrameGeometry(
  segments: readonly FrameSegment[],
  prism: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const templatePositions = prism.getAttribute('position');
  const templateNormals = prism.getAttribute('normal');
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const start = new THREE.Vector3();
  const end = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const rotation = new THREE.Quaternion();
  const transform = new THREE.Matrix4();
  const normalTransform = new THREE.Matrix3();

  for (const segment of segments) {
    start.set(segment.start[0], segment.start[1], segment.start[2] ?? 0);
    end.set(segment.end[0], segment.end[1], segment.end[2] ?? 0);
    direction.subVectors(end, start);
    const length = direction.length();
    if (length < 1e-7) continue;

    rotation.setFromUnitVectors(up, direction.multiplyScalar(1 / length));
    transform.compose(
      vertex.addVectors(start, end).multiplyScalar(0.5),
      rotation,
      direction.set(segment.width, length, segment.depth),
    );
    normalTransform.getNormalMatrix(transform);

    for (let index = 0; index < templatePositions.count; index += 1) {
      vertex.fromBufferAttribute(templatePositions, index).applyMatrix4(transform);
      normal.fromBufferAttribute(templateNormals, index).applyMatrix3(normalTransform).normalize();
      const shade = THREE.MathUtils.clamp(
        (segment.brightness ?? 1) * (0.74 + Math.max(0, normal.y) * 0.14 + Math.abs(normal.z) * 0.12),
        0.35,
        1,
      );

      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(shade, shade, shade);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createFrameMaterial(appearance: FrameAppearance): MeshStandardNodeMaterial {
  const emission = appearance.emissiveIntensity ?? 0;
  const material = new MeshStandardNodeMaterial({
    name: appearance.name,
    color: appearance.color,
    roughness: appearance.roughness,
    metalness: appearance.metalness,
    emissive: emission > 0 ? appearance.color : 0x000000,
    emissiveIntensity: emission,
    vertexColors: true,
    flatShading: true,
    transparent: false,
    opacity: 1,
    side: THREE.FrontSide,
    depthTest: true,
    depthWrite: true,
    fog: false,
  });

  material.userData.actualCockpitStructure = true;
  material.userData.actualInstrumentEmitter = emission > 0;
  material.userData.actualStellarLighting = true;
  material.userData.transmissionPasses = 0;
  return material;
}

/**
 * Real low-poly AURORA canopy architecture in the existing foreground scene.
 *
 * Structure remains camera-attached and physically lit by the same genuine
 * stellar sources as the ship. Only the actual cyan and amber cockpit strips
 * emit; the open central windshield never obscures reachable celestial bodies.
 */
export class CockpitFrame {
  readonly group = new THREE.Group();

  private readonly minimumView = new THREE.Vector2();
  private readonly maximumView = new THREE.Vector2();

  constructor(camera: THREE.PerspectiveCamera) {
    this.group.name = 'AURORA VX-9 camera-local cockpit canopy';
    this.group.visible = false;

    const prism = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    let triangles = 0;
    for (const appearance of AURORA_FRAME_APPEARANCES) {
      const geometry = createFrameGeometry(appearance.segments, prism);
      const mesh = new THREE.Mesh(geometry, createFrameMaterial(appearance));
      mesh.name = appearance.name;
      mesh.frustumCulled = false;
      triangles += geometry.getAttribute('position').count / 3;
      this.group.add(mesh);
    }
    prism.dispose();

    this.group.userData.physicalCockpitFrame = true;
    this.group.userData.cameraLocal = true;
    this.group.userData.boundedDrawCalls = AURORA_FRAME_APPEARANCES.length;
    this.group.userData.triangleCount = triangles;
    this.group.userData.clearWindshieldFraction = CLEAR_WINDSHIELD_FRACTION;
    this.group.userData.actualInstrumentEmitters = ['cyan', 'amber'];
    this.group.userData.actualStellarLighting = true;
    this.group.userData.transmissionPasses = 0;
    this.syncProjection(camera);
  }

  /** Keep the real side rails at screen edges through FOV, aspect, and lens changes. */
  syncProjection(camera: THREE.PerspectiveCamera): void {
    camera.getViewBounds(FRAME_DEPTH_METERS, this.minimumView, this.maximumView);
    this.group.position.set(
      (this.minimumView.x + this.maximumView.x) * 0.5,
      (this.minimumView.y + this.maximumView.y) * 0.5,
      -FRAME_DEPTH_METERS,
    );
    this.group.scale.set(
      (this.maximumView.x - this.minimumView.x) * 0.5,
      (this.maximumView.y - this.minimumView.y) * 0.5,
      1,
    );
    this.group.userData.physicalDepthMeters = FRAME_DEPTH_METERS;
    this.group.userData.viewportAspect = camera.aspect;
    this.group.userData.viewportFieldOfViewDegrees = camera.fov;
  }

  dispose(): void {
    for (const part of this.group.children) {
      if (!(part instanceof THREE.Mesh)) continue;
      part.geometry.dispose();
      (part.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
    this.group.clear();
  }
}
