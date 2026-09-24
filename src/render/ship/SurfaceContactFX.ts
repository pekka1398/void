import * as THREE from 'three';
import {
  bodyFixedToWorld,
  type BodyFrame,
  type Vec3,
} from '../../core';
import type { SurfaceLifecycleSnapshot } from '../../simulation/ship/SurfaceLifecycleController';
import type { SurfaceContactKind } from '../../terrain/SurfaceContactAuthority';
import {
  WORLD_METERS_PER_RENDER_UNIT,
  observerRelativeRenderPosition,
  orthonormalObserverBasis,
  rollObserverBasis,
  shipLocalOffsetToWorld,
  type ActiveObserverPose,
} from '../ObserverPose';
import type { AuroraLiftThrusterSocket } from './AuroraSurfaceKit';

export interface SurfaceContactFxInput extends SurfaceLifecycleSnapshot {
  readonly bodyFrame?: BodyFrame;
  readonly observer: Pick<ActiveObserverPose, 'address'>;
  readonly liftThrusterSocketsMeters: readonly AuroraLiftThrusterSocket[];
  readonly surfaceGravityMetersPerSecondSquared: number;
  readonly elapsedSeconds: number;
  readonly deltaSeconds: number;
  /** Render-interpolated actual ship orientation, when different from the support plane. */
  readonly bodyFixedUp?: Readonly<Vec3>;
  readonly shipRollRadians?: number;
}

export interface SurfaceContactFxBudget {
  readonly particles: number;
  readonly shards: number;
  readonly draws: 2;
}

export const SURFACE_CONTACT_FX_BUDGETS: Readonly<Record<'high' | 'low', SurfaceContactFxBudget>> = Object.freeze({
  high: Object.freeze({ particles: 192, shards: 32, draws: 2 }),
  low: Object.freeze({ particles: 64, shards: 12, draws: 2 }),
});

type ParticleKind = 'dust' | 'spark' | 'shard';

interface Particle {
  active: boolean;
  kind: ParticleKind;
  birthSeconds: number;
  lifetimeSeconds: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  normal: THREE.Vector3;
  gravity: number;
  radius: number;
  red: number;
  green: number;
  blue: number;
  phase: number;
}

function createParticle(): Particle {
  return {
    active: false,
    kind: 'dust',
    birthSeconds: 0,
    lifetimeSeconds: 0,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    gravity: 0,
    radius: 0,
    red: 0,
    green: 0,
    blue: 0,
    phase: 0,
  };
}

function randomUnit(index: number, salt: number): number {
  let word = (index ^ salt) >>> 0;
  word = Math.imul(word ^ (word >>> 16), 0x7feb352d);
  word = Math.imul(word ^ (word >>> 15), 0x846ca68b);
  return ((word ^ (word >>> 16)) >>> 0) / 0x1_0000_0000;
}

function drySurface(kind: SurfaceContactKind): boolean {
  return kind === 'soil' || kind === 'rock' || kind === 'sand' || kind === 'ice';
}

function materialTint(kind: SurfaceContactKind): readonly [number, number, number] {
  if (kind === 'sand') return [0.48, 0.27, 0.31];
  if (kind === 'ice') return [0.16, 0.5, 0.67];
  if (kind === 'soil') return [0.28, 0.24, 0.47];
  return [0.22, 0.26, 0.43];
}

const LOCAL_UP = new THREE.Vector3(0, 1, 0);
const SURFACE_EMISSION_HEIGHT_METERS = 0.045;
const DUST_MAXIMUM_RADIUS_METERS = 0.625;
const DUST_THICKNESS_RATIO = 0.12;
const DUST_MAXIMUM_CENTER_HEIGHT_METERS = 0.22;
const DUST_SHADOW_VIOLET = new THREE.Color(0x33145e);

/**
 * Two bounded world-depth draws. Emission comes only from a ready, dry shared
 * contact generation. Historical dust and ballistic shards live in body-fixed
 * double-precision meters, not in camera-local speed-field space.
 */
export class SurfaceContactFX {
  readonly group = new THREE.Group();
  readonly budget: SurfaceContactFxBudget;
  private readonly particles: Particle[];
  private readonly shards: Particle[];
  private readonly plasma: THREE.InstancedMesh;
  private readonly debris: THREE.InstancedMesh;
  private readonly transform = new THREE.Object3D();
  private readonly anchor = new THREE.Vector3();
  private readonly contactNormal = new THREE.Vector3();
  private readonly tangentRight = new THREE.Vector3();
  private readonly tangentForward = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly scratch2 = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private nextParticle = 0;
  private nextShard = 0;
  private emissionSerial = 0;
  private lastEventSerial: number | undefined;
  private lastBodyId: string | undefined;
  private lastElapsedSeconds = 0;
  private dustAccumulator = 0;
  private shardAccumulator = 0;
  private touchdownEvents = 0;

  constructor(quality: 'high' | 'low' | 'fallback' = 'high') {
    this.budget = SURFACE_CONTACT_FX_BUDGETS[quality === 'high' ? 'high' : 'low'];
    this.particles = Array.from({ length: this.budget.particles }, createParticle);
    this.shards = Array.from({ length: this.budget.shards }, createParticle);
    this.group.name = 'Body-fixed AURORA surface contact effects';
    this.group.scale.setScalar(1 / WORLD_METERS_PER_RENDER_UNIT);
    this.group.visible = false;
    Object.assign(this.group.userData, {
      worldAnchored: true,
      bodyFixedHistory: true,
      sharedWorldDepth: true,
      cameraLocal: false,
      boundedDrawCalls: 2,
      particleCapacity: this.budget.particles,
      shardCapacity: this.budget.shards,
      addedPostProcessPasses: 0,
      touchdownEvents: 0,
    });

    const plasmaMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.plasma = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), plasmaMaterial, this.budget.particles);
    this.plasma.name = 'Bounded cyan-violet lift plasma and faceted ground wash';
    this.plasma.renderOrder = 1;

    const debrisMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: true,
      roughness: 0.98,
      metalness: 0,
      depthTest: true,
      depthWrite: true,
    });
    this.debris = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), debrisMaterial, this.budget.shards);
    this.debris.name = 'Bounded physical ballistic surface shards';
    for (const mesh of [this.plasma, this.debris]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      this.group.add(mesh);
    }
  }

  get diagnostics(): Readonly<{
    particles: number; shards: number; draws: number; touchdownEvents: number;
    eventSerial: number | undefined; bodyId: string | undefined;
  }> {
    return {
      particles: this.plasma.count,
      shards: this.debris.count,
      draws: Number(this.plasma.visible) + Number(this.debris.visible),
      touchdownEvents: this.touchdownEvents,
      eventSerial: this.lastEventSerial,
      bodyId: this.lastBodyId,
    };
  }

  reset(): void {
    for (const particle of this.particles) particle.active = false;
    for (const shard of this.shards) shard.active = false;
    this.nextParticle = 0;
    this.nextShard = 0;
    this.emissionSerial = 0;
    this.lastElapsedSeconds = 0;
    this.dustAccumulator = 0;
    this.shardAccumulator = 0;
    this.lastEventSerial = undefined;
    this.lastBodyId = undefined;
    this.touchdownEvents = 0;
    this.plasma.count = 0;
    this.debris.count = 0;
    this.plasma.visible = false;
    this.debris.visible = false;
    this.group.visible = false;
    Object.assign(this.group.userData, { particleCount: 0, shardCount: 0, actualDrawCalls: 0, touchdownEvents: 0 });
  }

  update(input: SurfaceContactFxInput): void {
    if (this.lastBodyId !== input.bodyId || input.elapsedSeconds < this.lastElapsedSeconds) this.reset();
    this.lastBodyId = input.bodyId;
    this.lastElapsedSeconds = input.elapsedSeconds;
    const frame = input.bodyFrame;
    const origin = input.bodyFixedOriginMeters;
    const forward = input.bodyFixedForward;
    if (!frame || frame.id !== input.bodyId || !origin || !forward ||
      input.contactPointsBodyFixedMeters.length === 0) {
      this.group.visible = false;
      this.plasma.visible = false;
      this.debris.visible = false;
      this.plasma.count = 0;
      this.debris.count = 0;
      this.lastEventSerial = input.eventSerial;
      return;
    }

    this.anchor.set(0, 0, 0);
    for (const point of input.contactPointsBodyFixedMeters) this.anchor.add(point);
    this.anchor.multiplyScalar(1 / input.contactPointsBodyFixedMeters.length);
    const anchorAddress = bodyFixedToWorld(frame, this.anchor);
    const relative = observerRelativeRenderPosition(anchorAddress, input.observer);
    this.group.position.set(relative.x, relative.y, relative.z);
    this.group.rotation.set(0, frame.rotationRadians, 0);
    this.contactNormal.copy(input.contactNormalBodyFixed).normalize();
    const groundBasis = orthonormalObserverBasis(forward, input.contactNormalBodyFixed);
    this.tangentRight.copy(groundBasis.right);
    this.tangentForward.copy(groundBasis.forward);

    const readyDry = input.contactReady && drySurface(input.surfaceKind);
    const thrust = readyDry ? THREE.MathUtils.clamp(input.surfaceThrust, 0, 1) : 0;
    const density = THREE.MathUtils.clamp(input.atmosphereDensity, 0, 1);
    const nearGround = Math.pow(THREE.MathUtils.clamp(1 - Math.max(0, input.clearanceMeters) / 20, 0, 1), 2);
    const delta = Number.isFinite(input.deltaSeconds) ? THREE.MathUtils.clamp(input.deltaSeconds, 0, 0.1) : 0;
    const newEvent = this.lastEventSerial !== input.eventSerial;
    this.lastEventSerial = input.eventSerial;
    if (newEvent && readyDry && input.surfacePhase === 'touchdown-settle' &&
      input.touchdownImpulseMetersPerSecond > 0) {
      this.touchdownEvents += 1;
      const impact = THREE.MathUtils.clamp(input.touchdownImpulseMetersPerSecond / 2.5, 0.35, 1);
      const amount = this.budget.particles === 192 ? 16 : 8;
      for (let index = 0; index < amount; index += 1) {
        this.emit(input, density > 0.08 && index % 4 !== 0 ? 'dust' : 'spark', impact);
      }
      const fragments = density < 0.12 ? (this.budget.shards === 32 ? 8 : 4) : 2;
      for (let index = 0; index < fragments; index += 1) this.emit(input, 'shard', impact);
    }

    if (readyDry && thrust > 0.025 && nearGround > 0) {
      this.dustAccumulator += delta * thrust * nearGround * density *
        (this.budget.particles === 192 ? 42 : 16);
      while (this.dustAccumulator >= 1) {
        this.dustAccumulator -= 1;
        this.emit(input, 'dust', thrust);
      }
      this.shardAccumulator += delta * thrust * nearGround * (1 - density) *
        (this.budget.shards === 32 ? 7 : 3);
      while (this.shardAccumulator >= 1) {
        this.shardAccumulator -= 1;
        this.emit(input, 'shard', thrust);
      }
    }

    let particleCount = this.writeLiftPlumes(input, thrust);
    const liftPlumeCount = particleCount;
    let atmosphericDustCount = 0;
    let sparkCount = 0;
    for (const particle of this.particles) {
      if (particleCount >= this.budget.particles) break;
      if (this.writeParticle(this.plasma, particle, particleCount, input.elapsedSeconds)) {
        particleCount += 1;
        if (particle.kind === 'dust') atmosphericDustCount += 1;
        else if (particle.kind === 'spark') sparkCount += 1;
      }
    }
    let shardCount = 0;
    for (const shard of this.shards) {
      if (this.writeParticle(this.debris, shard, shardCount, input.elapsedSeconds)) shardCount += 1;
    }
    this.finishMesh(this.plasma, particleCount);
    this.finishMesh(this.debris, shardCount);
    this.group.visible = particleCount > 0 || shardCount > 0;
    Object.assign(this.group.userData, {
      bodyId: input.bodyId,
      eventSerial: input.eventSerial,
      touchdownEvents: this.touchdownEvents,
      particleCount,
      liftPlumeCount,
      atmosphericDustCount,
      sparkCount,
      shardCount,
      actualDrawCalls: Number(particleCount > 0) + Number(shardCount > 0),
      surfaceKind: input.surfaceKind,
      contactReady: input.contactReady,
      surfaceThrust: thrust,
      contactGenerationId: input.contactGenerationId,
    });
  }

  private emit(input: SurfaceContactFxInput, kind: ParticleKind, energy: number): void {
    const serial = ++this.emissionSerial;
    const particle = kind === 'shard'
      ? this.shards[this.nextShard++ % this.shards.length]!
      : this.particles[this.nextParticle++ % this.particles.length]!;
    const seed = (input.eventSerial * 65_537 + serial) >>> 0;
    const angle = randomUnit(seed, 17) * Math.PI * 2;
    const spread = 1.5 + randomUnit(seed, 29) * (kind === 'shard' ? 3 : 5);
    const lift = kind === 'dust' ? 0.06 + randomUnit(seed, 47) * 0.14 : 0.8 + randomUnit(seed, 47) * 2.2;
    const point = input.contactPointsBodyFixedMeters[serial % input.contactPointsBodyFixedMeters.length]!;
    particle.active = true;
    particle.kind = kind;
    particle.birthSeconds = input.elapsedSeconds;
    particle.lifetimeSeconds = kind === 'dust'
      ? 0.65 + randomUnit(seed, 71) * 0.55
      : kind === 'spark' ? 0.35 + randomUnit(seed, 71) * 0.45 : 1.5 + randomUnit(seed, 71) * 0.8;
    particle.position.copy(point).addScaledVector(this.contactNormal, SURFACE_EMISSION_HEIGHT_METERS);
    particle.normal.copy(this.contactNormal);
    particle.velocity.copy(this.tangentRight).multiplyScalar(Math.cos(angle))
      .addScaledVector(this.tangentForward, Math.sin(angle))
      .multiplyScalar(spread * (0.5 + energy * 0.8))
      .addScaledVector(this.contactNormal, lift * (0.45 + energy * 0.75));
    const gravity = Number.isFinite(input.surfaceGravityMetersPerSecondSquared)
      ? Math.max(0, input.surfaceGravityMetersPerSecondSquared) : 0;
    particle.gravity = gravity * (kind === 'dust' ? 0.07 : kind === 'spark' ? 0.35 : 1);
    particle.radius = kind === 'dust' ? 0.1 + randomUnit(seed, 83) * 0.16
      : kind === 'spark' ? 0.025 + randomUnit(seed, 83) * 0.045 : 0.045 + randomUnit(seed, 83) * 0.085;
    const tint = materialTint(input.surfaceKind);
    if (kind === 'spark') {
      const magenta = serial % 3 === 0;
      particle.red = magenta ? 2.3 : 0.22;
      particle.green = magenta ? 0.22 : 2.1;
      particle.blue = 2.7;
    } else if (kind === 'dust') {
      // Dust shares the additive draw with hot lift plasma. Keep its own
      // contribution subdued instead of dimming genuine jets and sparks.
      this.color.setRGB(tint[0], tint[1], tint[2])
        .lerp(DUST_SHADOW_VIOLET, 0.3).multiplyScalar(0.27);
      particle.red = this.color.r; particle.green = this.color.g; particle.blue = this.color.b;
    } else {
      particle.red = tint[0]; particle.green = tint[1]; particle.blue = tint[2];
    }
    particle.phase = angle;
  }

  private writeLiftPlumes(input: SurfaceContactFxInput, thrust: number): number {
    if (thrust < 0.025 || !input.bodyFixedOriginMeters || !input.bodyFixedForward) return 0;
    const basis = rollObserverBasis(orthonormalObserverBasis(input.bodyFixedForward,
      input.bodyFixedUp ?? input.contactNormalBodyFixed), input.shipRollRadians ?? 0);
    const segments = this.budget.particles === 192 ? 4 : 2;
    let count = 0;
    for (const socket of input.liftThrusterSocketsMeters) {
      if (count + segments > this.budget.particles) break;
      const offset = shipLocalOffsetToWorld(socket.positionMeters, basis);
      this.scratch.copy(input.bodyFixedOriginMeters).add(offset);
      const direction = shipLocalOffsetToWorld(socket.direction, basis);
      this.scratch2.copy(direction).normalize();
      const distanceToGround = (this.scratch.x - this.anchor.x) * this.contactNormal.x +
        (this.scratch.y - this.anchor.y) * this.contactNormal.y +
        (this.scratch.z - this.anchor.z) * this.contactNormal.z;
      const projectedDirection = Math.max(0.15, -this.scratch2.dot(this.contactNormal));
      const length = Math.min(0.5 + thrust * 5.3, Math.max(0.06, distanceToGround - 0.035) / projectedDirection);
      for (let segment = 0; segment < segments; segment += 1) {
        const fraction = (segment + 0.5) / segments;
        const flicker = 0.9 + 0.1 * Math.sin(input.elapsedSeconds * 22 + count * 1.91);
        const radius = socket.radiusMeters * (0.66 - fraction * 0.4) * (0.48 + thrust * 0.85) * flicker;
        this.transform.position.copy(this.scratch).addScaledVector(this.scratch2, fraction * length).sub(this.anchor);
        this.transform.quaternion.setFromUnitVectors(LOCAL_UP, this.scratch2);
        this.transform.scale.set(radius, length / segments * 0.71, radius);
        this.transform.updateMatrix();
        this.plasma.setMatrixAt(count, this.transform.matrix);
        this.color.setRGB(0.25 + fraction * 0.55, 2.8 - fraction * 2.1, 3.3 - fraction * 0.5)
          .multiplyScalar(thrust * flicker);
        this.plasma.setColorAt(count++, this.color);
      }
    }
    return count;
  }

  private writeParticle(mesh: THREE.InstancedMesh, particle: Particle, index: number, now: number): boolean {
    if (!particle.active) return false;
    const age = now - particle.birthSeconds;
    if (age < 0 || age >= particle.lifetimeSeconds) { particle.active = false; return false; }
    const life = age / particle.lifetimeSeconds;
    const travel = particle.kind === 'dust' ? (1 - Math.exp(-age * 1.15)) / 1.15 : age;
    const height = particle.velocity.dot(particle.normal) * travel - 0.5 * particle.gravity * age * age;
    if (particle.kind === 'shard' && age > 0.1 && height < -0.04) {
      particle.active = false;
      return false;
    }
    this.transform.position.copy(particle.position).addScaledVector(particle.velocity, travel)
      .addScaledVector(particle.normal, -0.5 * particle.gravity * age * age);
    const radius = particle.kind === 'dust'
      ? Math.min(DUST_MAXIMUM_RADIUS_METERS, particle.radius * (1 + life * 1.4))
      : particle.radius * (particle.kind === 'spark' ? Math.max(0.12, 1 - life) : 1);
    if (particle.kind === 'dust') {
      const thickness = radius * DUST_THICKNESS_RATIO;
      const centerHeight = SURFACE_EMISSION_HEIGHT_METERS + height;
      const groundHuggingHeight = THREE.MathUtils.clamp(centerHeight,
        thickness + 0.012, DUST_MAXIMUM_CENTER_HEIGHT_METERS);
      this.transform.position.addScaledVector(particle.normal, groundHuggingHeight - centerHeight);
      // Keep the thin axis perpendicular to the actual contact plane. A
      // tumbling flattened octahedron can still become a tall floating slab.
      this.transform.quaternion.setFromUnitVectors(LOCAL_UP, particle.normal);
      this.transform.rotateY(particle.phase + age * 0.15);
      this.transform.scale.set(radius, thickness, radius);
    } else {
      if (height < 0.02) this.transform.position.addScaledVector(particle.normal, 0.02 - height);
      this.transform.rotation.set(particle.phase + age * 1.1, particle.phase * 0.7 + age * 0.6, age * 1.7);
      this.transform.scale.set(radius, radius * 1.3, radius);
    }
    this.transform.position.sub(this.anchor);
    this.transform.updateMatrix();
    mesh.setMatrixAt(index, this.transform.matrix);
    const fade = particle.kind === 'shard' ? 1 : Math.pow(1 - life, 1.7);
    this.color.setRGB(particle.red * fade, particle.green * fade, particle.blue * fade);
    mesh.setColorAt(index, this.color);
    return true;
  }

  private finishMesh(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.visible = count > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.plasma, this.debris]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.group.removeFromParent();
    this.group.clear();
  }
}
