import * as THREE from 'three';
import { PALETTE } from '../style/Palette';

const MAX_STREAKS = 768;
const MAX_ION_FILAMENTS = 58;

export interface SpeedFieldEnvironment {
  /** Never portray optical motion while the real canonical ship is landed. */
  landed?: boolean;
  /** Reduce local streak brightness through actual dense planet-fixed weather. */
  atmosphereDensity?: number;
  /** Spawn ring fragments only when the caller verifies a real ring volume. */
  ringProximity?: number;
}

export class SpeedField {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly ionGeometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly ionPositions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly offsets: Float32Array;
  private readonly capacity: number;
  private readonly debris: THREE.InstancedMesh;
  private readonly streakMaterial: THREE.LineBasicMaterial;
  private readonly ionMaterial: THREE.LineBasicMaterial;
  private readonly debrisCount: number;
  private readonly debrisTransform = new THREE.Object3D();
  private speed = 0;
  private count = 0;

  constructor(maximumStreaks = MAX_STREAKS) {
    this.group.name = 'Camera-local speed dust';
    this.capacity = THREE.MathUtils.clamp(Math.round(maximumStreaks), 1, MAX_STREAKS);
    this.group.userData.cameraLocal = true;
    this.group.userData.maximumParticles = this.capacity;
    this.group.userData.catalogStarsModified = false;
    this.group.userData.velocityPalette = ['cyan', 'magenta', 'violet', 'amber'];
    this.group.userData.actualVelocityDriven = false;
    this.group.userData.speedMetersPerSecond = 0;
    this.group.userData.visibleDust = 0;
    this.group.userData.ringDebrisAuthentic = false;
    this.positions = new Float32Array(this.capacity * 6);
    this.ionPositions = new Float32Array(MAX_ION_FILAMENTS * 6);
    this.velocities = new Float32Array(this.capacity);
    this.offsets = new Float32Array(this.capacity * 3);
    const colors = new Float32Array(this.capacity * 6);
    const palette = [
      PALETTE.cyan,
      0x59f9ff,
      PALETTE.violet,
      PALETTE.cyan,
      PALETTE.magenta,
      0xa25cff,
      PALETTE.cyan,
      0xff69dc,
      PALETTE.amber,
      PALETTE.cyan,
      PALETTE.magenta,
      0x47d4ff,
    ];
    for (let index = 0; index < this.capacity; index++) {
      const angle = (index * 2.39996323) % (Math.PI * 2);
      const layer = index % 4;
      const radius = 2.55 + ((index * 13.73) % 22.5) + layer * 0.61;
      this.offsets[index * 3] = Math.cos(angle) * radius;
      this.offsets[index * 3 + 1] = Math.sin(angle) * radius * (0.57 + layer * 0.055);
      this.offsets[index * 3 + 2] = -((index * 7.17 + layer * 11.9) % 104);
      this.velocities[index] = 0.5 + ((index * 3.71) % 1) + layer * 0.08;
      const color = new THREE.Color(palette[index % palette.length]);
      for (let endpoint = 0; endpoint < 2; endpoint++) {
        const offset = index * 6 + endpoint * 3;
        const intensity = endpoint === 0 ? 1 : 0.08 + ((index * 17) % 5) * 0.035;
        colors[offset] = color.r * intensity;
        colors[offset + 1] = color.g * intensity;
        colors[offset + 2] = color.b * intensity;
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.streakMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const streaks = new THREE.LineSegments(this.geometry, this.streakMaterial);
    streaks.name = 'Velocity-aligned cyan violet and magenta dust';
    streaks.frustumCulled = false;
    streaks.renderOrder = 11;
    this.group.add(streaks);

    this.ionGeometry = new THREE.BufferGeometry();
    this.ionGeometry.setAttribute('position', new THREE.BufferAttribute(this.ionPositions, 3));
    const ionColors = new Float32Array(MAX_ION_FILAMENTS * 6);
    const ionPalette = [
      new THREE.Color('#75FAFF'),
      new THREE.Color('#9864FF'),
      new THREE.Color('#FF55CF'),
      new THREE.Color('#FFD17A'),
    ];
    for (let index = 0; index < MAX_ION_FILAMENTS; index += 1) {
      const tone = ionPalette[index % ionPalette.length]!;
      const offset = index * 6;
      ionColors[offset] = tone.r;
      ionColors[offset + 1] = tone.g;
      ionColors[offset + 2] = tone.b;
      ionColors[offset + 3] = tone.r * 0.26;
      ionColors[offset + 4] = tone.g * 0.26;
      ionColors[offset + 5] = tone.b * 0.26;
    }
    this.ionGeometry.setAttribute('color', new THREE.BufferAttribute(ionColors, 3));
    this.ionGeometry.setDrawRange(0, 0);
    this.ionMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const filaments = new THREE.LineSegments(this.ionGeometry, this.ionMaterial);
    filaments.name = 'Bounded camera-local near-field ion filaments';
    filaments.frustumCulled = false;
    filaments.renderOrder = 12;
    this.group.add(filaments);

    this.debrisCount = Math.min(86, Math.max(24, Math.round(this.capacity / 9)));
    this.debris = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.15, 0),
      new THREE.MeshStandardMaterial({
        color: 0xd0ffff,
        emissive: 0x087f96,
        emissiveIntensity: 0.61,
        roughness: 0.76,
        flatShading: true,
      }),
      this.debrisCount,
    );
    this.debris.name = 'Bounded local faceted ring dust';
    this.debris.frustumCulled = false;
    this.debris.visible = false;
    this.debris.userData.angularTealIce = true;
    const debrisColors = [
      new THREE.Color('#1ECECC'),
      new THREE.Color('#24769F'),
      new THREE.Color('#4DE6DB'),
      new THREE.Color('#346EAA'),
      new THREE.Color('#33C5E0'),
    ];
    for (let index = 0; index < this.debrisCount; index += 1) {
      this.debris.setColorAt(index, debrisColors[index % debrisColors.length]!);
    }
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    this.group.add(this.debris);
    this.group.frustumCulled = false;
  }

  update(
    delta: number,
    intensity: number,
    mode: string,
    speedMetersPerSecond?: number,
    environment?: SpeedFieldEnvironment,
  ) {
    const frame = Number.isFinite(delta) ? THREE.MathUtils.clamp(delta, 0, 0.12) : 0;
    const physicallyDriven = speedMetersPerSecond !== undefined && Number.isFinite(speedMetersPerSecond);
    let target: number;

    if (physicallyDriven) {
      const actualSpeed = Math.max(0, speedMetersPerSecond);
      const atmosphere = THREE.MathUtils.clamp(environment?.atmosphereDensity ?? 0, 0, 1);
      const referenceSpeed = mode === 'hyper' || mode === 'hyperdrive'
        ? 4_000_000
        : mode === 'pulse'
          ? 1_100_000
          : mode === 'boost'
            ? 185_000
            : 95_000;
      const speedEnergy = 1 - Math.exp(-actualSpeed / referenceSpeed);
      const profileCoverage = mode === 'hyper' || mode === 'hyperdrive'
        ? 0.62
        : mode === 'pulse'
          ? 0.54
          : mode === 'boost'
            ? 0.37
            : 0.052;
      target = profileCoverage * speedEnergy * (1 - atmosphere * 0.57);
      this.group.userData.actualVelocityDriven = true;
      this.group.userData.speedMetersPerSecond = actualSpeed;
      this.group.userData.motionProfile = mode;

      if (environment?.landed || actualSpeed < 2) {
        target = 0;
        this.speed = 0;
      }

      this.streakMaterial.opacity = 0.46 + speedEnergy * 0.29;
      this.ionMaterial.opacity = 0.25 + speedEnergy * 0.23;
    } else {
      // Existing independent consumers keep the historical profile contract.
      target = mode === 'hyper'
        ? 0.95
        : mode === 'pulse'
          ? 0.78
          : mode === 'boost'
            ? 0.56
            : intensity * 0.065;
      this.group.userData.actualVelocityDriven = false;
    }

    this.speed = THREE.MathUtils.damp(this.speed, target, physicallyDriven ? 6.8 : 8.5, frame);
    this.count = Math.round(this.speed * this.capacity);
    this.group.userData.visibleDust = this.count;
    const ionCount = Math.min(MAX_ION_FILAMENTS, Math.floor(this.count * 0.085));
    const streakCount = Math.max(0, this.count - ionCount);
    const length = 0.12 + this.speed * this.speed * (physicallyDriven ? 13.5 : 16.5);
    for (let index = 0; index < streakCount; index++) {
      const base = index * 3;
      this.offsets[base + 2] += frame * (12 + this.speed * 115) * this.velocities[index]!;
      if (this.offsets[base + 2]! > 8) this.offsets[base + 2] = -98;
      const offset = index * 6;
      const x = this.offsets[base]!;
      const y = this.offsets[base + 1]!;
      const z = this.offsets[base + 2]!;
      this.positions[offset] = x;
      this.positions[offset + 1] = y;
      this.positions[offset + 2] = z;
      this.positions[offset + 3] = x;
      this.positions[offset + 4] = y;
      this.positions[offset + 5] = z - length * this.velocities[index]!;
    }
    this.geometry.setDrawRange(0, streakCount * 2);
    this.geometry.attributes.position!.needsUpdate = true;

    for (let index = 0; index < ionCount; index += 1) {
      const source = Math.min(streakCount - 1, (index * 11 + 5) % Math.max(1, streakCount));
      const base = source * 3;
      const offset = index * 6;
      const side = index % 2 === 0 ? 1 : -1;
      const x = this.offsets[base]! * 0.78 + side * 1.35;
      const y = this.offsets[base + 1]! * 0.68 - 0.38;
      const z = this.offsets[base + 2]! * 0.64;
      this.ionPositions[offset] = x;
      this.ionPositions[offset + 1] = y;
      this.ionPositions[offset + 2] = z;
      this.ionPositions[offset + 3] = x + side * 0.14;
      this.ionPositions[offset + 4] = y - 0.045;
      this.ionPositions[offset + 5] = z - length * 0.7;
    }
    this.ionGeometry.setDrawRange(0, ionCount * 2);
    this.ionGeometry.attributes.position!.needsUpdate = true;

    // Coarse local ice/rock belongs in a boost-speed ring encounter, not the
    // open pulse corridor where it otherwise becomes fake green star-sized blocks.
    const physicallyInsideRing = (environment?.ringProximity ?? 0) > 0.03;
    this.group.userData.ringDebrisAuthentic = physicallyDriven && physicallyInsideRing;
    this.debris.visible = mode === 'boost' && (
      physicallyDriven
        ? physicallyInsideRing && !environment?.landed && Number(speedMetersPerSecond) > 20
        : true
    );
    if (this.debris.visible) {
      const visibleDebris = Math.min(this.debrisCount, Math.max(8, Math.round(this.debrisCount * this.speed)));
      this.debris.count = visibleDebris;
      for (let index = 0; index < visibleDebris; index++) {
        const source = (index * 7) % this.capacity;
        const offset = source * 3;
        this.debrisTransform.position.set(
          this.offsets[offset]! * 0.76,
          this.offsets[offset + 1]! * 0.74,
          this.offsets[offset + 2]! * 0.66 - 3,
        );
        const scale = 0.48 + ((index * 7.37) % 1) * 1.25;
        this.debrisTransform.scale.set(
          scale * (0.82 + (index % 3) * 0.19),
          scale * (0.49 + (index % 4) * 0.14),
          scale * (0.76 + (index % 5) * 0.11),
        );
        this.debrisTransform.rotation.set(index * 0.47, index * 1.13, this.speed * index * 0.14);
        this.debrisTransform.updateMatrix();
        this.debris.setMatrixAt(index, this.debrisTransform.matrix);
      }
      this.debris.instanceMatrix.needsUpdate = true;
    }
  }

  get activeCount() {
    return this.count;
  }

  get maximumCount() {
    return this.capacity;
  }

  dispose() {
    this.geometry.dispose();
    this.ionGeometry.dispose();
    (this.group.children[0] as THREE.LineSegments).material instanceof THREE.Material &&
      ((this.group.children[0] as THREE.LineSegments).material as THREE.Material).dispose();
    (this.group.children[1] as THREE.LineSegments).material instanceof THREE.Material &&
      ((this.group.children[1] as THREE.LineSegments).material as THREE.Material).dispose();
    this.debris.geometry.dispose();
    (this.debris.material as THREE.Material).dispose();
  }
}
