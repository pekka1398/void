import * as THREE from 'three';
import {
  ENGINE_PLUME_PARTICLES_PER_CELL,
  sampleEnginePlumeParticle,
} from './EnginePlumeParticles';
import type { ShipVisual } from './ProceduralShip';

const SHOCK_CELLS_PER_ENGINE = 6;
const RADIAL_SEGMENTS = 8;
const PROCEDURAL_NOZZLE_RADIUS = 0.267;

interface PropulsionState {
  mode?: string;
  visualThrust?: number;
  actualSpeedDriven?: boolean;
  speedMetersPerSecond?: number;
}

interface PlasmaSection {
  depth: number;
  radius: number;
  red: number;
  green: number;
  blue: number;
}

interface EngineAnchor {
  side: 'port' | 'starboard';
  x: number;
  y: number;
  z: number;
  socketName?: string;
  nozzleRadius?: number;
}

interface BlueFireGeometry {
  readonly geometry: THREE.BufferGeometry;
  readonly vertices: Float32Array;
  readonly colors: Float32Array;
  readonly diamond: Float32Array;
  readonly verticesPerDiamond: number;
}

/**
 * Keep every original shock cell and draw while surrounding it with genuinely
 * detached faceted plasma fragments. One shared dynamic compound is instanced
 * at all twelve actual engine cells: five fragments become sixty blue embers.
 */
function createBlueFireShockGeometry(): BlueFireGeometry {
  const original = new THREE.OctahedronGeometry(1, 0);
  const originalPositions = original.getAttribute('position');
  const diamond = new Float32Array(originalPositions.array);
  const verticesPerDiamond = originalPositions.count;
  const vertices = new Float32Array(
    diamond.length * (1 + ENGINE_PLUME_PARTICLES_PER_CELL),
  );
  const colors = new Float32Array(vertices.length);
  vertices.set(diamond);

  for (let vertex = 0; vertex < verticesPerDiamond; vertex += 1) {
    colors[vertex * 3] = 1;
    colors[vertex * 3 + 1] = 0.98;
    colors[vertex * 3 + 2] = 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(vertices, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage),
  );
  // The animated physical fragments stay aft of their real nozzle but can
  // extend farther than the fixed central octahedron.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 4.5), 8);
  geometry.userData.dynamicBlueFire = true;
  geometry.userData.physicalBlueFireParticles = true;
  geometry.userData.detachedBlueFireGeometry = true;
  geometry.userData.blueFireParticlesPerShock = ENGINE_PLUME_PARTICLES_PER_CELL;
  geometry.userData.centralShockVertexCount = verticesPerDiamond;
  geometry.userData.particleVertexCount = verticesPerDiamond;
  geometry.userData.rearwardPhysicalParticles = true;
  original.dispose();
  return { geometry, vertices, colors, diamond, verticesPerDiamond };
}

/**
 * A genuinely three-dimensional faceted plasma envelope, open at both ends.
 * Colored axial sections keep its silhouette lively without textures or shaders.
 */
function createPlasmaSheath(): THREE.BufferGeometry {
  const sections: readonly PlasmaSection[] = [
    { depth: 0.018, radius: 0.139, red: 0.72, green: 1.0, blue: 1.0 },
    { depth: 0.105, radius: 0.233, red: 0.29, green: 0.92, blue: 1.0 },
    { depth: 0.285, radius: 0.208, red: 0.12, green: 0.8, blue: 1.0 },
    { depth: 0.48, radius: 0.164, red: 0.075, green: 0.57, blue: 0.88 },
    { depth: 0.76, radius: 0.091, red: 0.04, green: 0.29, blue: 0.59 },
    { depth: 1.01, radius: 0.023, red: 0.018, green: 0.12, blue: 0.3 },
  ];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (const section of sections) {
    for (let segment = 0; segment < RADIAL_SEGMENTS; segment += 1) {
      const angle = (segment / RADIAL_SEGMENTS) * Math.PI * 2;
      const facet = segment % 2 === 0 ? 1 : 0.78;
      positions.push(
        Math.cos(angle) * section.radius,
        Math.sin(angle) * section.radius * 0.82,
        section.depth,
      );
      colors.push(section.red * facet, section.green * facet, section.blue * facet);
    }
  }

  for (let section = 0; section < sections.length - 1; section += 1) {
    for (let segment = 0; segment < RADIAL_SEGMENTS; segment += 1) {
      const current = section * RADIAL_SEGMENTS + segment;
      const next = section * RADIAL_SEGMENTS + (segment + 1) % RADIAL_SEGMENTS;
      indices.push(current, current + RADIAL_SEGMENTS, next);
      indices.push(next, current + RADIAL_SEGMENTS, next + RADIAL_SEGMENTS);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Three crossed tapered planes make the hot column readable from any chase angle. */
function createIonColumn(): THREE.BufferGeometry {
  const sections: readonly PlasmaSection[] = [
    { depth: 0.012, radius: 0.095, red: 1.0, green: 1.0, blue: 1.0 },
    { depth: 0.13, radius: 0.128, red: 0.79, green: 1.0, blue: 1.0 },
    { depth: 0.39, radius: 0.104, red: 0.38, green: 0.95, blue: 1.0 },
    { depth: 0.72, radius: 0.064, red: 0.13, green: 0.66, blue: 0.94 },
    { depth: 1.0, radius: 0.012, red: 0.04, green: 0.2, blue: 0.41 },
  ];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let plane = 0; plane < 3; plane += 1) {
    const angle = (plane * Math.PI) / 3;
    const horizontal = Math.cos(angle);
    const vertical = Math.sin(angle);
    const firstVertex = positions.length / 3;

    for (const section of sections) {
      positions.push(
        -horizontal * section.radius, -vertical * section.radius, section.depth,
        horizontal * section.radius, vertical * section.radius, section.depth,
      );
      colors.push(
        section.red, section.green, section.blue,
        section.red, section.green, section.blue,
      );
    }

    for (let section = 0; section < sections.length - 1; section += 1) {
      const current = firstVertex + section * 2;
      indices.push(current, current + 1, current + 2);
      indices.push(current + 1, current + 3, current + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function additiveMaterial(color: number, opacity: number, vertexColors = false): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    vertexColors,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
}

/**
 * Three bounded instanced draws anchored to the spacecraft's real twin nozzles.
 *
 * The group is a same-coordinate-space sibling of the opaque ship rather than
 * a child of its existing two-element trail roots. Its transform is synchronized after
 * every actual ship update, preserving both the original physical anchors and
 * the authoritative ship triangle count.
 */
export class EngineExhaust {
  readonly group = new THREE.Group();

  private readonly ship: ShipVisual;
  private readonly roots: readonly THREE.Group[];
  private readonly engineAnchors: readonly EngineAnchor[];
  private readonly sheath: THREE.InstancedMesh;
  private readonly columns: THREE.InstancedMesh;
  private readonly shocks: THREE.InstancedMesh;
  private readonly blueFire: BlueFireGeometry;
  private readonly transform = new THREE.Object3D();
  private readonly axis = new THREE.Vector3();

  constructor(ship: ShipVisual) {
    this.ship = ship;
    this.roots = [
      'Twin port tapered ion plume',
      'Twin starboard tapered ion plume',
    ].map((name) => {
      const root = ship.group.getObjectByName(name);
      if (!(root instanceof THREE.Group)) {
        throw new Error(`Spacecraft is missing its actual propulsion anchor: ${name}`);
      }
      return root;
    });
    this.engineAnchors = this.roots.map((root, index) => {
      const anchor: EngineAnchor = {
        side: index === 0 ? 'port' : 'starboard',
        x: root.position.x,
        y: root.position.y,
        z: root.position.z,
      };
      const expectedSocket = index === 0 ? 'SOCKET_ENGINE_PORT' : 'SOCKET_ENGINE_STARBOARD';
      const nozzleRadius = root.userData.nozzleRadius as number | undefined;
      if (
        root.userData.authoredSocket === true &&
        root.userData.authoredSocketName === expectedSocket &&
        ship.group.getObjectByName(expectedSocket) &&
        typeof nozzleRadius === 'number' &&
        Number.isFinite(nozzleRadius) &&
        nozzleRadius > 0
      ) {
        anchor.socketName = expectedSocket;
        anchor.nozzleRadius = nozzleRadius;
      }
      return anchor;
    });

    this.group.name = 'Physically anchored twin-engine ion exhaust';
    this.group.userData.actualEngineCount = this.roots.length;
    this.group.userData.shockCellCount = this.roots.length * SHOCK_CELLS_PER_ENGINE;
    this.group.userData.boundedDrawCalls = 3;
    this.group.userData.worldAnchoredEngines = true;
    this.group.userData.cameraLocal = ship.group.userData.worldSpaceExterior !== true;
    this.group.userData.physicalMetersPerGltfUnit = ship.group.userData.physicalMetersPerGltfUnit;
    this.group.userData.engineAnchors = this.engineAnchors;
    this.group.userData.animatedBlueFire = true;
    this.group.userData.blueFireParticlesPerShock = ENGINE_PLUME_PARTICLES_PER_CELL;
    this.group.userData.blueFireParticleCount = this.roots.length
      * SHOCK_CELLS_PER_ENGINE * ENGINE_PLUME_PARTICLES_PER_CELL;
    this.group.userData.blueFireParticleCapacity = this.group.userData.blueFireParticleCount;
    this.group.userData.rearwardPhysicalParticles = true;
    if (this.engineAnchors.every((anchor) => anchor.socketName && anchor.nozzleRadius)) {
      this.group.userData.authoredSocketDriven = true;
      this.group.userData.authoredEngineSocketNames = this.engineAnchors.map((anchor) => anchor.socketName);
      this.group.userData.authoredNozzleRadii = this.engineAnchors.map((anchor) => anchor.nozzleRadius);
    }

    this.sheath = new THREE.InstancedMesh(
      createPlasmaSheath(),
      additiveMaterial(0x228fff, 0.23, true),
      this.roots.length,
    );
    this.sheath.name = 'Instanced tapered cyan plasma sheaths';

    this.columns = new THREE.InstancedMesh(
      createIonColumn(),
      additiveMaterial(0xc1f5ff, 0.58, true),
      this.roots.length,
    );
    this.columns.name = 'Instanced white-hot ion columns';

    this.blueFire = createBlueFireShockGeometry();
    this.shocks = new THREE.InstancedMesh(
      this.blueFire.geometry,
      additiveMaterial(0xb6eeff, 0.44, true),
      this.roots.length * SHOCK_CELLS_PER_ENGINE,
    );
    this.shocks.name = 'Instanced faceted ion shock diamonds';
    this.shocks.userData.animatedBlueFire = true;
    this.shocks.userData.blueFireParticlesPerShock = ENGINE_PLUME_PARTICLES_PER_CELL;

    for (const layer of [this.sheath, this.columns, this.shocks]) {
      layer.frustumCulled = false;
      layer.renderOrder = 1;
      layer.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(layer);
    }

    for (let engine = 0; engine < this.roots.length; engine += 1) {
      for (let cell = 0; cell < SHOCK_CELLS_PER_ENGINE; cell += 1) {
        const fade = cell / Math.max(1, SHOCK_CELLS_PER_ENGINE - 1);
        this.shocks.setColorAt(
          engine * SHOCK_CELLS_PER_ENGINE + cell,
          new THREE.Color().setRGB(
            0.9 - fade * 0.77,
            1 - fade * 0.23,
            1,
          ),
        );
      }
    }
    if (this.shocks.instanceColor) this.shocks.instanceColor.needsUpdate = true;

    this.update(0);
  }

  update(elapsedSeconds = performance.now() / 1_000): void {
    this.group.position.copy(this.ship.group.position);
    this.group.quaternion.copy(this.ship.group.quaternion);
    this.group.scale.copy(this.ship.group.scale);

    const state = this.ship.group.userData.propulsion as PropulsionState | undefined;
    const thrust = THREE.MathUtils.clamp(state?.visualThrust ?? 0.2, 0, 1);
    this.updateBlueFire(elapsedSeconds, thrust);
    const pulse = 0.94 + Math.sin(elapsedSeconds * 13.4) * (0.025 + thrust * 0.028);
    const sheathMaterial = this.sheath.material as THREE.MeshBasicMaterial;
    const columnMaterial = this.columns.material as THREE.MeshBasicMaterial;
    const shockMaterial = this.shocks.material as THREE.MeshBasicMaterial;

    sheathMaterial.opacity = 0.085 + thrust * 0.245;
    columnMaterial.opacity = 0.27 + thrust * 0.46;
    shockMaterial.opacity = (0.28 + thrust * 0.56) * pulse;
    columnMaterial.color.setRGB(0.58 + thrust * 0.39, 0.94 + thrust * 0.08, 1.06);

    for (let engine = 0; engine < this.roots.length; engine += 1) {
      const root = this.roots[engine]!;
      const anchor = this.engineAnchors[engine]!;
      anchor.x = root.position.x;
      anchor.y = root.position.y;
      anchor.z = root.position.z;
      const plumeLength = Math.max(0.18, root.scale.z);
      const physicalNozzleScale = anchor.nozzleRadius
        ? THREE.MathUtils.clamp(anchor.nozzleRadius / PROCEDURAL_NOZZLE_RADIUS, 0.25, 8)
        : 1;
      const width = Math.max(0.35, root.scale.x) * physicalNozzleScale;
      const verticalWidth = root.scale.y * physicalNozzleScale;

      this.transform.position.copy(root.position);
      this.transform.quaternion.copy(root.quaternion);
      this.transform.scale.set(width * 1.12, verticalWidth * 1.06, plumeLength * 0.97);
      this.transform.updateMatrix();
      this.sheath.setMatrixAt(engine, this.transform.matrix);

      this.transform.scale.set(width * pulse, verticalWidth * pulse, plumeLength * 0.81);
      this.transform.updateMatrix();
      this.columns.setMatrixAt(engine, this.transform.matrix);

      for (let cell = 0; cell < SHOCK_CELLS_PER_ENGINE; cell += 1) {
        const filamentPhase = elapsedSeconds * (1.6 + thrust * 3)
          + engine * 2.13 + cell * 0.77;
        const depth = 0.055 + cell * 0.11
          + Math.sin(filamentPhase) * 0.012;
        const taper = 1 - cell / (SHOCK_CELLS_PER_ENGINE + 1.45);
        const shimmer = 0.89 + Math.sin(elapsedSeconds * 12.2 - cell * 1.28 + engine * 0.35) * 0.11;
        const radius = (0.086 + thrust * 0.038) * taper * shimmer;

        this.axis.set(0, 0, depth * plumeLength).applyQuaternion(root.quaternion);
        this.transform.position.copy(root.position).add(this.axis);
        this.transform.quaternion.copy(root.quaternion);
        this.transform.rotateZ(filamentPhase);
        this.transform.scale.set(radius * width, radius * verticalWidth, radius * (1.7 + thrust * 1.1));
        this.transform.updateMatrix();
        this.shocks.setMatrixAt(engine * SHOCK_CELLS_PER_ENGINE + cell, this.transform.matrix);
      }
    }

    this.sheath.instanceMatrix.needsUpdate = true;
    this.columns.instanceMatrix.needsUpdate = true;
    this.shocks.instanceMatrix.needsUpdate = true;

    this.group.userData.actualSpeedDriven = state?.actualSpeedDriven ?? false;
    this.group.userData.speedMetersPerSecond = state?.speedMetersPerSecond ?? 0;
    this.group.userData.visualThrust = thrust;
    this.group.userData.propulsionMode = state?.mode ?? 'cruise';
  }

  /** Animate the five real shared fragments once; twelve cells instance them. */
  private updateBlueFire(elapsedSeconds: number, thrust: number): void {
    const root = this.roots[0]!;
    const anchor = this.engineAnchors[0]!;
    const plumeLength = Math.max(0.18, root.scale.z);
    const nozzleRadius = anchor.nozzleRadius ?? PROCEDURAL_NOZZLE_RADIUS;
    const physicalNozzleScale = THREE.MathUtils.clamp(
      nozzleRadius / PROCEDURAL_NOZZLE_RADIUS,
      0.25,
      8,
    );
    const { vertices, colors, diamond, verticesPerDiamond } = this.blueFire;

    for (let index = 0; index < ENGINE_PLUME_PARTICLES_PER_CELL; index += 1) {
      const particle = sampleEnginePlumeParticle({
        particleIndex: index,
        elapsedSeconds,
        visualThrust: thrust,
        plumeLength,
        nozzleRadius,
      });
      const firstVertex = (index + 1) * verticesPerDiamond;
      const intensity = Math.max(0.045, particle.alpha);
      // Shock instances are deliberately narrow. Give their real embedded
      // particles enough physical cross-section to survive that final scale.
      const filamentRadius = particle.radius * (2.7 + thrust * 0.65)
        * (0.86 + physicalNozzleScale * 0.18);
      const radialCenterScale = 1.7 + thrust * 0.52;
      const axialStretch = 1.85 + thrust * 0.72;
      const aftAdvection = 1.65 + thrust * 0.55
        + (physicalNozzleScale - 1) * 0.18;
      const rearwardCenter = Math.max(
        particle.z * aftAdvection,
        filamentRadius * axialStretch + 0.022,
      );

      for (let vertex = 0; vertex < verticesPerDiamond; vertex += 1) {
        const source = vertex * 3;
        const destination = (firstVertex + vertex) * 3;
        vertices[destination] = particle.x * radialCenterScale
          + diamond[source]! * filamentRadius;
        vertices[destination + 1] = particle.y * radialCenterScale
          + diamond[source + 1]! * filamentRadius * 0.72;
        vertices[destination + 2] = rearwardCenter + diamond[source + 2]!
          * filamentRadius * axialStretch;
        colors[destination] = particle.red * intensity;
        colors[destination + 1] = particle.green * intensity;
        colors[destination + 2] = particle.blue * intensity;
      }
    }

    this.blueFire.geometry.getAttribute('position').needsUpdate = true;
    this.blueFire.geometry.getAttribute('color').needsUpdate = true;
    this.group.userData.blueFireElapsedSeconds = elapsedSeconds;
    this.group.userData.blueFireVisualThrust = thrust;
    this.group.userData.blueFireNozzleRadius = nozzleRadius;
    this.group.userData.blueFirePlumeLength = plumeLength;
  }

  dispose(): void {
    for (const layer of [this.sheath, this.columns, this.shocks]) {
      layer.geometry.dispose();
      (layer.material as THREE.Material).dispose();
      layer.dispose();
    }
    this.group.removeFromParent();
    this.group.clear();
  }
}
