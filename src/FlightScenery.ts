import * as THREE from 'three/webgpu';
import { AtmosphereShading, CloudShading, earthLikeAtmosphere, GroundMaterial, SceneryPipeline, StarField } from './sceneryCore';
import type { GamePlanet } from './GamePlanet';
import type { Vec3 } from './orbitCore';

export interface SceneryFrame {
  cameraBodyFixed: Vec3;
  renderOriginBodyFixed: Vec3;
  sunBodyFixed: Vec3;
  renderToBody: THREE.Matrix4;
  camera: THREE.PerspectiveCamera;
  focalPixels: number;
  time: number;
}

/** Connect the body-fixed scenery shaders to the game's focus-relative inertial scene. */
export class FlightScenery {
  readonly atmosphere: AtmosphereShading;
  readonly clouds: CloudShading;
  readonly ground: GroundMaterial;
  readonly stars = new StarField();
  readonly pipeline: SceneryPipeline;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, config: GamePlanet) {
    this.atmosphere = new AtmosphereShading(earthLikeAtmosphere(config.planet.terrain.radiusMeters));
    this.clouds = new CloudShading(this.atmosphere);
    this.ground = new GroundMaterial(this.atmosphere, config.rockHeight, config.snowHeight);
    this.atmosphere.enabled.value = config.atmosphere ? 1 : 0;
    this.clouds.enabled.value = config.atmosphere ? 1 : 0;
    this.clouds.seaLevel.value = config.seaLevel;
    this.ground.seaLevel.value = config.seaLevel;
    this.ground.oceanEnabled.value = config.ocean ? 1 : 0;
    // The star catalogue is inertial (ecliptic z-up), even while the planet spins.
    this.stars.points.rotation.x = -Math.PI / 2;
    scene.add(this.stars.points);
    this.pipeline = new SceneryPipeline(renderer, this.atmosphere, this.clouds);
  }

  update(frame: SceneryFrame): void {
    const { cameraBodyFixed, sunBodyFixed, renderToBody, camera } = frame;
    this.atmosphere.update(cameraBodyFixed, sunBodyFixed, camera, renderToBody);
    this.clouds.update(cameraBodyFixed, frame.focalPixels);
    this.ground.renderToBody.value.copy(renderToBody);
    this.ground.renderCameraPosition.value.copy(camera.position);
    this.ground.update(cameraBodyFixed, frame.time, frame.renderOriginBodyFixed);
    this.stars.points.position.copy(camera.position);
    const up = this.atmosphere.cameraUp.value;
    const sunMu = up.x * sunBodyFixed.x + up.y * sunBodyFixed.y + up.z * sunBodyFixed.z;
    const smooth = (a: number, b: number, value: number) => {
      const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };
    const daylight = smooth(-0.18, 0.02, sunMu) * (1 - smooth(0, 60e3, this.atmosphere.cameraAltitude.value)) * this.atmosphere.enabled.value;
    this.stars.brightness.value = 0.08 * (1 - daylight);
  }
}
