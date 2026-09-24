import * as THREE from 'three';
import type { GalacticAddress, Vec3 } from '../../core';
import type { CelestialLightFrame } from '../../lighting';
import type { SurfacePhase } from '../../simulation/ship/ShipState';
import {
  WORLD_METERS_PER_RENDER_UNIT,
  observerRelativeRenderPosition,
  orthonormalObserverBasis,
  rollObserverBasis,
  type ActiveObserverPose,
} from '../ObserverPose';
import { AURORA_PHYSICAL_METERS_PER_GLTF_UNIT } from './AuroraAsset';
import { EngineExhaust } from './EngineExhaust';
import type { ShipVisual } from './ProceduralShip';

/** Structural interface also satisfied by the validated additive AURORA kit. */
export interface WorldShipSurfaceKit {
  readonly group: THREE.Group;
  setDeployment(gearProgress: number, rampProgress: number): void;
  dispose(): void;
}

export interface WorldShipPresentationInput {
  readonly shipAddress: GalacticAddress;
  readonly observer: Pick<ActiveObserverPose, 'address' | 'owner'>;
  readonly forward: Readonly<Vec3>;
  /** Unrolled physical ship up; use the support normal while parked. */
  readonly up: Readonly<Vec3>;
  readonly rollRadians: number;
  readonly elapsedSeconds: number;
  readonly deltaSeconds: number;
  readonly throttle: number;
  readonly mode: string;
  readonly speedMetersPerSecond: number;
  readonly surfacePhase?: SurfacePhase;
  readonly gearProgress?: number;
  readonly rampProgress?: number;
  readonly visible?: boolean;
  readonly exhaustVisible?: boolean;
}

/**
 * The one physical exterior AURORA. Add `root` to the world's opaque-depth
 * scene; never render it after clearing terrain depth. Its children are native
 * glTF meters, and only this root converts meters to renderer units.
 */
export class WorldShipPresentation {
  readonly root = new THREE.Group();
  readonly ship: ShipVisual;
  readonly exhaust: EngineExhaust;
  readonly metersPerRenderUnit: number;
  private readonly orientationMatrix = new THREE.Matrix4();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly backward = new THREE.Vector3();
  private readonly mainTrailRoots: THREE.Object3D[];
  private surfaceKit: WorldShipSurfaceKit | undefined;

  constructor(ship: ShipVisual, options: { readonly metersPerRenderUnit?: number } = {}) {
    this.ship = ship;
    this.metersPerRenderUnit = options.metersPerRenderUnit ?? WORLD_METERS_PER_RENDER_UNIT;
    if (!Number.isFinite(this.metersPerRenderUnit) || this.metersPerRenderUnit <= 0) {
      throw new RangeError('World spacecraft scale must be a finite positive number of meters.');
    }
    if (!ship.promoteToPhysicalMeters?.()) {
      throw new Error('The spacecraft cannot be converted to its authenticated native-meter scale.');
    }

    this.root.name = 'AURORA world-space spacecraft';
    this.root.scale.setScalar(AURORA_PHYSICAL_METERS_PER_GLTF_UNIT / this.metersPerRenderUnit);
    Object.assign(this.root.userData, {
      worldSpaceExterior: true,
      sharedWorldDepth: true,
      cameraLocal: false,
      physicalMetersPerGltfUnit: AURORA_PHYSICAL_METERS_PER_GLTF_UNIT,
      metersPerRenderUnit: this.metersPerRenderUnit,
      physicalCelestialLighting: true,
      boundedPropulsionDrawCalls: 3,
      visualBankRadians: 0,
    });
    ship.group.traverse((part) => {
      if (!(part instanceof THREE.Mesh)) return;
      part.renderOrder = 0;
      for (const material of Array.isArray(part.material) ? part.material : [part.material]) {
        material.depthTest = true;
        material.depthWrite = !material.transparent;
        if (!material.transparent) material.opacity = 1;
      }
    });
    this.root.add(ship.group);
    this.exhaust = new EngineExhaust(ship);
    this.root.add(this.exhaust.group);
    this.mainTrailRoots = [
      ship.group.getObjectByName('Twin port tapered ion plume'),
      ship.group.getObjectByName('Twin starboard tapered ion plume'),
    ].filter((part): part is THREE.Object3D => part !== undefined);
  }

  /** Install only an independently validated, native-meter surface kit. */
  installSurfaceKit(kit: WorldShipSurfaceKit): void {
    if (this.surfaceKit === kit) return;
    if (kit.group.userData.surfaceKitValidated !== true ||
      kit.group.userData.physicalMetersPerGltfUnit !== AURORA_PHYSICAL_METERS_PER_GLTF_UNIT) {
      throw new Error('Only a validated native-meter AURORA surface kit may be installed.');
    }
    if (this.surfaceKit) {
      this.surfaceKit.group.removeFromParent();
      this.surfaceKit.dispose();
    }
    this.surfaceKit = kit;
    kit.group.position.set(0, 0, 0);
    kit.group.quaternion.identity();
    kit.group.scale.setScalar(1);
    this.root.add(kit.group);
    this.root.userData.surfaceKitInstalled = true;
  }

  update(input: WorldShipPresentationInput): void {
    const position = observerRelativeRenderPosition(input.shipAddress, input.observer, this.metersPerRenderUnit);
    this.root.position.set(position.x, position.y, position.z);
    const bank = Number.isFinite(input.rollRadians) ? input.rollRadians : 0;
    const basis = rollObserverBasis(orthonormalObserverBasis(input.forward, input.up), bank);
    this.right.set(basis.right.x, basis.right.y, basis.right.z);
    this.up.set(basis.up.x, basis.up.y, basis.up.z);
    this.backward.set(-basis.forward.x, -basis.forward.y, -basis.forward.z);
    this.orientationMatrix.makeBasis(this.right, this.up, this.backward);
    this.root.quaternion.setFromRotationMatrix(this.orientationMatrix);
    this.root.visible = input.visible ?? input.observer.owner !== 'ship-cockpit';

    this.ship.setThrottle(input.throttle, input.mode, input.speedMetersPerSecond);
    this.ship.update(input.elapsedSeconds, 0, input.deltaSeconds);
    const propulsion = this.ship.group.userData.propulsion as { bankRadians?: number } | undefined;
    if (propulsion) propulsion.bankRadians = bank;
    const phase = input.surfacePhase ?? 'airborne';
    const mainEngineActive = input.exhaustVisible ??
      (phase === 'airborne' || phase === 'landing-armed' || phase === 'takeoff-climb');
    const propulsionVisible = mainEngineActive && this.root.visible;
    this.exhaust.group.visible = propulsionVisible;
    for (const root of this.mainTrailRoots) root.visible = propulsionVisible;
    if (propulsionVisible) this.exhaust.update(input.elapsedSeconds);
    this.surfaceKit?.setDeployment(input.gearProgress ?? 0, input.rampProgress ?? 0);
    this.root.userData.visualBankRadians = bank;
    this.ship.group.userData.visualBankRadians = bank;
    this.root.userData.surfacePhase = phase;
    this.root.userData.gearProgress = input.gearProgress ?? 0;
    this.root.userData.rampProgress = input.rampProgress ?? 0;
    this.root.userData.mainEngineActive = mainEngineActive;
  }

  /** Diagnostics describe the actual shared world light frame, not extra ship-only lights. */
  setCelestialFrame(frame: CelestialLightFrame): void {
    const active = frame.sources.filter((source) => source.active && source.id);
    Object.assign(this.root.userData, {
      celestialStarCount: active.length,
      visibleCelestialStarCount: active.filter((source) => source.visibility > 0.01).length,
      celestialSourceIds: active.map((source) => source.id),
      dominantStarId: active.find((source) => source.slot === frame.dominantSlot)?.id,
      celestialDaylight: frame.daylight,
      celestialNight: frame.night,
      celestialFrameTimeSeconds: frame.timeSeconds,
    });
  }

  /** The caller retains ownership of ShipVisual and disposes its hull once. */
  dispose(): void {
    this.surfaceKit?.dispose();
    this.surfaceKit = undefined;
    this.exhaust.dispose();
    this.root.remove(this.ship.group);
    this.root.removeFromParent();
    this.root.clear();
  }
}
