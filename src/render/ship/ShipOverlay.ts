import * as THREE from 'three';
import type { CelestialLightFrame, CelestialLightSource } from '../../lighting';
import { CockpitFrame } from './CockpitFrame';
import type { ShipVisual } from './ProceduralShip';

/** Shared initialized WebGPU renderer and its genuine WebGL backend surface. */
export interface ShipForegroundRenderer {
  autoClear: boolean;
  info: { autoReset: boolean };
  clearDepth(): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

/**
 * The independently authored camera-local cockpit frame only. The exterior
 * spacecraft, landing kit, and exhaust belong to WorldShipPresentation and
 * retain the same depth buffer as real terrain. Only an occupied cockpit may
 * clear that world depth to draw its instrument panel.
 */
export class ShipOverlay {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly sourceCamera: THREE.PerspectiveCamera;
  private readonly ship: ShipVisual;
  private readonly cockpitFrame: CockpitFrame;
  private readonly fillLight: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly cameraWorldQuaternion = new THREE.Quaternion();
  private readonly cameraLocalDirection = new THREE.Vector3();
  private readonly combinedStellarColor = new THREE.Color();
  private celestialFrame: CelestialLightFrame | undefined;
  private celestialLightingFresh = false;
  private lastCelestialLightingThrust = Number.NaN;
  private cockpitMode = false;

  constructor(ship: ShipVisual, sourceCamera: THREE.PerspectiveCamera) {
    this.ship = ship;
    this.sourceCamera = sourceCamera;
    this.camera = new THREE.PerspectiveCamera(sourceCamera.fov, sourceCamera.aspect, 0.025, 96);
    this.camera.zoom = sourceCamera.zoom;
    this.camera.filmGauge = sourceCamera.filmGauge;
    this.camera.filmOffset = sourceCamera.filmOffset;
    this.camera.updateProjectionMatrix();
    this.camera.name = 'Camera-local cockpit foreground camera';
    this.scene.name = 'Dedicated cockpit-only foreground composition';
    this.scene.background = null;
    this.scene.userData.cockpitOnlyForeground = true;
    this.scene.userData.exteriorSharesWorldDepth = true;
    this.scene.userData.physicalCockpitLighting = true;
    this.scene.userData.physicalCelestialLighting = true;
    this.scene.userData.maximumCelestialLightSlots = 3;
    this.scene.userData.celestialStarCount = 0;
    this.scene.add(this.camera);

    this.fillLight = new THREE.HemisphereLight(0xfff1e5, 0x211847, 1.08);
    this.fillLight.name = 'Soft ivory cockpit foreground fill';
    this.scene.add(this.fillLight);

    this.keyLight = new THREE.DirectionalLight(0xffe7ce, 2.14);
    this.keyLight.name = 'Warm faceted cockpit key light';
    this.keyLight.position.set(-4.5, 5.6, 5.8);
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x42cdff, 0.7);
    this.rimLight.name = 'Restrained cyan cockpit rim light';
    this.rimLight.position.set(4.4, 1.9, -5.0);
    this.scene.add(this.rimLight);

    this.cockpitFrame = new CockpitFrame(this.camera);
    this.camera.add(this.cockpitFrame.group);
    this.scene.userData.boundedPropulsionDrawCalls = 0;
    this.scene.userData.physicalCockpitFrame = true;
    this.scene.userData.cockpitMode = false;
    this.scene.userData.flightViewMode = 'chase';
    this.scene.userData.cockpitFrameDrawCalls = this.cockpitFrame.group.userData.boundedDrawCalls;
    this.scene.userData.cockpitFrameTriangles = this.cockpitFrame.group.userData.triangleCount;
    this.scene.userData.cockpitWindshieldClearance = this.cockpitFrame.group.userData.clearWindshieldFraction;
  }

  /** Exterior visibility remains the world presentation owner's decision. */
  setCockpitMode(active: boolean): void {
    if (this.cockpitMode === active) return;
    this.cockpitMode = active;
    this.cockpitFrame.group.visible = active;
    this.scene.userData.cockpitMode = active;
    this.scene.userData.flightViewMode = active ? 'cockpit' : 'chase';
  }

  /**
   * Illuminate the occupied cockpit from the same actual orbiting suns as the
   * surrounding world. This does not create a second exterior-lighting scene.
   */
  setCelestialFrame(frame: CelestialLightFrame): void {
    this.celestialFrame = frame;
    const propulsion = this.ship.group.userData.propulsion as { visualThrust?: number } | undefined;
    const thrust = THREE.MathUtils.clamp(propulsion?.visualThrust ?? 0.2, 0, 1);
    this.syncCelestialLighting(thrust);
    this.lastCelestialLightingThrust = thrust;
    this.celestialLightingFresh = true;
  }

  render(renderer: ShipForegroundRenderer): void {
    this.syncProjection();
    if (!this.cockpitMode) return;
    const propulsion = this.ship.group.userData.propulsion as { visualThrust?: number } | undefined;
    const thrust = THREE.MathUtils.clamp(propulsion?.visualThrust ?? 0.2, 0, 1);
    if (this.celestialFrame) {
      if (
        !this.celestialLightingFresh ||
        Math.abs(this.lastCelestialLightingThrust - thrust) > 1e-8
      ) {
        this.syncCelestialLighting(thrust);
        this.lastCelestialLightingThrust = thrust;
      }
      this.celestialLightingFresh = false;
    } else {
      this.rimLight.intensity = 0.62 + thrust * 0.43;
      this.keyLight.intensity = 2.12 + thrust * 0.12;
    }

    const previousAutoClear = renderer.autoClear;
    const previousAutoReset = renderer.info.autoReset;
    renderer.autoClear = false;
    // The world pass has already reset frame counters. Keep them accumulating
    // so diagnostics include both world and cockpit instrument draw calls.
    renderer.info.autoReset = false;

    try {
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.autoClear = previousAutoClear;
      renderer.info.autoReset = previousAutoReset;
    }
  }

  dispose(): void {
    this.cockpitFrame.dispose();
    this.scene.clear();
  }

  private syncProjection(): void {
    const source = this.sourceCamera;
    if (
      this.camera.fov === source.fov &&
      this.camera.aspect === source.aspect &&
      this.camera.zoom === source.zoom &&
      this.camera.filmGauge === source.filmGauge &&
      this.camera.filmOffset === source.filmOffset
    ) return;

    this.camera.fov = source.fov;
    this.camera.aspect = source.aspect;
    this.camera.zoom = source.zoom;
    this.camera.filmGauge = source.filmGauge;
    this.camera.filmOffset = source.filmOffset;
    this.camera.updateProjectionMatrix();
    this.cockpitFrame.syncProjection(this.camera);
  }

  private syncCelestialLighting(thrust: number): void {
    const frame = this.celestialFrame;
    if (!frame) return;

    const active = frame.sources.filter((source) => source.active && source.id);
    const ranked = [...active].sort((left, right) => (
      right.receivedIrradianceSolar * right.visibility -
      left.receivedIrradianceSolar * left.visibility
    ));
    const dominant = ranked.find((source) => source.slot === frame.dominantSlot && source.visibility > 0)
      ?? ranked[0];
    const secondary = ranked.find((source) => source.slot !== dominant?.slot);
    const tertiary = ranked.find((source) => (
      source.slot !== dominant?.slot && source.slot !== secondary?.slot
    ));

    this.scene.userData.celestialStarCount = active.length;
    this.scene.userData.visibleCelestialStarCount = active.filter((source) => source.visibility > 0.01).length;
    this.scene.userData.celestialSourceIds = active.map((source) => source.id);
    this.scene.userData.dominantStarId = dominant?.id;
    this.scene.userData.celestialDaylight = frame.daylight;
    this.scene.userData.celestialNight = frame.night;
    this.scene.userData.celestialFrameTimeSeconds = frame.timeSeconds;

    if (!dominant) {
      this.keyLight.intensity = 0.16 + thrust * 0.08;
      this.rimLight.color.set(0x42cdff);
      this.rimLight.intensity = 0.42 + thrust * 0.43;
      this.fillLight.intensity = 0.29;
      return;
    }

    this.sourceCamera.getWorldQuaternion(this.cameraWorldQuaternion).invert();
    this.positionActualStellarLight(this.keyLight, dominant);
    this.applyActualStellarColor(this.keyLight.color, dominant);

    const daylight = THREE.MathUtils.clamp(frame.daylight, 0, 1);
    const twilight = THREE.MathUtils.clamp(frame.twilight, 0, 1);
    const night = THREE.MathUtils.clamp(frame.night, 0, 1);
    const dominantEnergy = Math.sqrt(Math.max(0, dominant.receivedIrradianceSolar)) *
      THREE.MathUtils.clamp(dominant.visibility, 0, 1);
    this.keyLight.intensity = THREE.MathUtils.clamp(
      0.17 + daylight * 0.72 + twilight * 0.34 +
        Math.min(1.35, dominantEnergy * 0.92) + thrust * 0.09,
      0.12,
      2.45,
    );

    this.combinedStellarColor.copy(this.keyLight.color);
    if (secondary && secondary.visibility > 0.005) {
      this.positionActualStellarLight(this.rimLight, secondary);
      this.applyActualStellarColor(this.rimLight.color, secondary);
      const secondaryEnergy = Math.sqrt(Math.max(0, secondary.receivedIrradianceSolar)) *
        THREE.MathUtils.clamp(secondary.visibility, 0, 1);
      this.combinedStellarColor.lerp(
        this.rimLight.color,
        THREE.MathUtils.clamp(secondaryEnergy * 0.24, 0.035, 0.28),
      );
      // The cyan engine is still a genuine local light when thrust increases.
      this.rimLight.color.lerp(new THREE.Color(0x42cdff), 0.12 + thrust * 0.2);
      this.rimLight.intensity = THREE.MathUtils.clamp(
        0.43 + Math.min(0.55, secondaryEnergy * 0.58) + thrust * 0.43,
        0.35,
        1.48,
      );
    } else {
      this.rimLight.color.set(0x42cdff);
      this.rimLight.position.set(4.4, 1.9, -5.0);
      this.rimLight.intensity = 0.48 + thrust * 0.43;
    }

    if (tertiary && tertiary.visibility > 0.005) {
      const third = new THREE.Color(
        tertiary.spectralColor.r * tertiary.atmosphericTransmittance.r,
        tertiary.spectralColor.g * tertiary.atmosphericTransmittance.g,
        tertiary.spectralColor.b * tertiary.atmosphericTransmittance.b,
      );
      this.combinedStellarColor.lerp(
        third,
        THREE.MathUtils.clamp(tertiary.receivedIrradianceSolar * 0.13, 0.015, 0.16),
      );
    }

    // Diffuse daylight is reflected by the real ship, atmosphere, and nearby
    // surface; it must not duplicate the amber direct suns on every face.
    // Retain their actual spectral tint while keeping bounced light neutral.
    this.fillLight.color.copy(this.combinedStellarColor)
      .lerp(new THREE.Color(0xe8f1ff), Math.min(0.76, daylight * 0.74 + twilight * 0.22))
      .lerp(new THREE.Color(0x766ed7), night * 0.58);
    this.fillLight.groundColor.set(0x25345c)
      .lerp(this.combinedStellarColor, daylight * frame.atmosphereDensity * 0.1);
    this.fillLight.intensity = THREE.MathUtils.clamp(
      0.31 + daylight * 0.99 + twilight * 0.2 +
        (tertiary ? Math.min(0.1, tertiary.receivedIrradianceSolar * 0.07) : 0),
      0.28,
      1.4,
    );
  }

  private positionActualStellarLight(light: THREE.DirectionalLight, source: CelestialLightSource): void {
    this.cameraLocalDirection.set(
      source.directionWorld.x,
      source.directionWorld.y,
      source.directionWorld.z,
    );
    if (this.cameraLocalDirection.lengthSq() < 1e-12) return;
    this.cameraLocalDirection.normalize().applyQuaternion(this.cameraWorldQuaternion);
    light.position.copy(this.cameraLocalDirection).multiplyScalar(8);
  }

  private applyActualStellarColor(destination: THREE.Color, source: CelestialLightSource): void {
    destination.setRGB(
      Math.max(0.025, source.spectralColor.r * source.atmosphericTransmittance.r),
      Math.max(0.025, source.spectralColor.g * source.atmosphericTransmittance.g),
      Math.max(0.025, source.spectralColor.b * source.atmosphericTransmittance.b),
    );
    const strongest = Math.max(destination.r, destination.g, destination.b);
    if (strongest > 1e-6) destination.multiplyScalar(1 / strongest);
  }
}
