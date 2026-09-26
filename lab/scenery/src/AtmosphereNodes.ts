import * as THREE from 'three/webgpu';
import {
  cross, dot, exp, float, Fn, If, length, Loop, max, min, mix, normalize, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4,
  getViewPosition, logarithmicDepthToViewZ, screenUV,
} from 'three/tsl';
import {
  buildTransmittanceTable, TRANSMITTANCE_HEIGHT, TRANSMITTANCE_WIDTH, type AtmosphereParams, type Vec3,
} from './Atmosphere';

type FloatNode = THREE.Node<'float'>;
type Vec3Node = THREE.Node<'vec3'>;

/** The Sun seen from Aurelia's distance (1 AU): angular radius, radians. */
export const SUN_ANGULAR_RADIUS = 0.004654;
/** Samples along each view ray through the air. */
const VIEW_STEPS = 32;

/**
 * The atmosphere on the GPU. Two users:
 *
 * - `sunTransmittance`, for the ground's shading: how much sunlight reaches a
 *   point through the air, from the transmittance table.
 * - `composite`, a full-screen pass over the rendered scene: every pixel's
 *   colour is dimmed by the air between it and the camera, and the light the
 *   air scatters toward the camera on the way is added. Sky pixels (nothing
 *   drawn, or stars) run to the top of the air, or to the ground sphere; the
 *   sun's disc is added to them.
 *
 * Render space is the planet's body-fixed axes with the camera at the origin.
 * Positions near the camera stay small in float32; the camera's own height
 * comes from the CPU in float64 (`cameraAltitude`), since subtracting two
 * 6,371 km radii in float32 would lose it to half a metre.
 */
export class AtmosphereShading {
  readonly transmittanceTable: THREE.DataTexture;
  /** Unit vector toward the sun, body-fixed. */
  readonly sunDirection = uniform(new THREE.Vector3(1, 0, 0));
  /** Sunlight above the air; the unit every radiance here is measured in. */
  readonly sunIlluminance = uniform(1);
  /** The planet centre in render space (camera-relative), metres. */
  readonly planetCenter = uniform(new THREE.Vector3());
  /** Unit vector from the planet centre through the camera. */
  readonly cameraUp = uniform(new THREE.Vector3(0, 0, 1));
  /** Camera height above the bottom radius, metres. */
  readonly cameraAltitude = uniform(1);
  /** 0 skips the air: the scene is shown as rendered, with the bare sun disc on the sky. */
  readonly enabled = uniform(1);
  /** Camera matrices for the composite pass, whose own camera is the full-screen quad's. */
  readonly projectionInverse = uniform(new THREE.Matrix4());
  readonly cameraRotation = uniform(new THREE.Matrix4());
  readonly cameraNear = uniform(1);
  readonly cameraFar = uniform(2);

  private readonly bottom: FloatNode;
  private readonly top: FloatNode;
  private readonly horizon: FloatNode;

  constructor(readonly params: AtmosphereParams) {
    const table = buildTransmittanceTable(params);
    const half = new Uint16Array(table.length);
    for (let i = 0; i < table.length; i += 1) half[i] = THREE.DataUtils.toHalfFloat(table[i]!);
    // Half floats filter linearly on every WebGL2 device; float textures need an extension.
    this.transmittanceTable = new THREE.DataTexture(half, TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType);
    this.transmittanceTable.magFilter = THREE.LinearFilter;
    this.transmittanceTable.minFilter = THREE.LinearFilter;
    this.transmittanceTable.wrapS = THREE.ClampToEdgeWrapping;
    this.transmittanceTable.wrapT = THREE.ClampToEdgeWrapping;
    this.transmittanceTable.colorSpace = THREE.NoColorSpace;
    this.transmittanceTable.needsUpdate = true;
    this.bottom = float(params.bottomRadius);
    this.top = float(params.topRadius);
    this.horizon = float(Math.sqrt(params.topRadius ** 2 - params.bottomRadius ** 2));
  }

  /**
   * Per frame. `cameraBodyFixed` is the camera's body-fixed position (planet centre at the origin), metres.
   */
  update(cameraBodyFixed: Vec3, sun: Vec3, camera: THREE.PerspectiveCamera): void {
    const r = Math.hypot(cameraBodyFixed.x, cameraBodyFixed.y, cameraBodyFixed.z);
    if (!(r > 0)) throw new RangeError(`AtmosphereShading.update: camera at the planet centre`);
    const sunLength = Math.hypot(sun.x, sun.y, sun.z);
    if (Math.abs(sunLength - 1) > 1e-9) throw new RangeError(`AtmosphereShading.update: sun direction length ${sunLength}`);
    this.planetCenter.value.set(-cameraBodyFixed.x, -cameraBodyFixed.y, -cameraBodyFixed.z);
    this.cameraUp.value.set(cameraBodyFixed.x / r, cameraBodyFixed.y / r, cameraBodyFixed.z / r);
    this.cameraAltitude.value = r - this.params.bottomRadius;
    this.sunDirection.value.set(sun.x, sun.y, sun.z);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    this.cameraRotation.value.copy(camera.matrixWorld);
    this.cameraNear.value = camera.near;
    this.cameraFar.value = camera.far;
  }

  /**
   * Transmittance from radius r (metres) toward a direction with zenith cosine mu, to space.
   * Zero once the ground sphere hides the sun, softened over the sun's radius.
   */
  sunTransmittance(r: FloatNode, mu: FloatNode): Vec3Node {
    const radius = min(r, this.top);
    const r2 = radius.mul(radius);
    const rho = sqrt(max(r2.sub(this.bottom.mul(this.bottom)), 0));
    const discriminant = r2.mul(mu.mul(mu).sub(1)).add(this.top.mul(this.top));
    const d = max(radius.negate().mul(mu).add(sqrt(max(discriminant, 0))), 0);
    const dMin = this.top.sub(radius);
    const dMax = rho.add(this.horizon);
    const x = d.sub(dMin).div(max(dMax.sub(dMin), 1e-3));
    const y = rho.div(this.horizon);
    // Coordinates are 0–1 between the first and last texel centres.
    const uv = vec2(
      x.mul((TRANSMITTANCE_WIDTH - 1) / TRANSMITTANCE_WIDTH).add(0.5 / TRANSMITTANCE_WIDTH),
      y.mul((TRANSMITTANCE_HEIGHT - 1) / TRANSMITTANCE_HEIGHT).add(0.5 / TRANSMITTANCE_HEIGHT),
    );
    const horizonMu = sqrt(max(float(1).sub(this.bottom.mul(this.bottom).div(r2)), 0)).negate();
    const visible = smoothstep(horizonMu.sub(SUN_ANGULAR_RADIUS), horizonMu.add(SUN_ANGULAR_RADIUS), mu);
    return texture(this.transmittanceTable, uv).rgb.mul(visible);
  }

  /** The composite pass: `color` and `depth` are the scene pass's textures (logarithmic depth). */
  composite(color: ReturnType<typeof texture>, depth: ReturnType<typeof texture>): ReturnType<typeof vec4> {
    const p = this.params;
    const pass = Fn(() => {
      const scene = color.rgb;
      const viewZ = logarithmicDepthToViewZ(depth.x, this.cameraNear, this.cameraFar);
      const viewDirection = normalize(getViewPosition(screenUV, float(0.5), this.projectionInverse));
      // Distance along the ray to what was drawn; sky pixels read about the far plane.
      const sceneDistance = viewZ.div(viewDirection.z);
      const rd = normalize(this.cameraRotation.mul(vec4(viewDirection, 0)).xyz);
      const sun = this.sunDirection;

      const r0 = this.bottom.add(this.cameraAltitude);
      const mu0 = dot(this.cameraUp, rd);
      // r0² − R², kept exact near the ground: altitude (2R + altitude).
      const aboveGround = this.cameraAltitude.mul(this.bottom.mul(2).add(this.cameraAltitude));
      const groundDiscriminant = r0.mul(r0).mul(mu0.mul(mu0)).sub(aboveGround);
      const hitsGround = mu0.lessThan(0).and(groundDiscriminant.greaterThanEqual(0));
      const groundDistance = r0.negate().mul(mu0).sub(sqrt(max(groundDiscriminant, 0)));
      const topDiscriminant = r0.mul(r0).mul(mu0.mul(mu0).sub(1)).add(this.top.mul(this.top));

      const transmittance = vec3(1, 1, 1).toVar();
      const inscatter = vec3(0, 0, 0).toVar();
      If(this.enabled.greaterThan(0).and(topDiscriminant.greaterThan(0)), () => {
        const topNear = r0.negate().mul(mu0).sub(sqrt(topDiscriminant));
        const topFar = r0.negate().mul(mu0).add(sqrt(topDiscriminant));
        const start = max(topNear, 0);
        const end = min(min(topFar, sceneDistance), mix(float(1e30), groundDistance, hitsGround.select(1, 0))).toVar();
        If(end.greaterThan(start), () => {
          const cosTheta = dot(rd, sun);
          const phaseR = float(3 / (16 * Math.PI)).mul(cosTheta.mul(cosTheta).add(1));
          const g = p.mieAnisotropy;
          const phaseM = float((3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g)))
            .mul(cosTheta.mul(cosTheta).add(1))
            .div(float(1 + g * g).sub(cosTheta.mul(2 * g)).pow(1.5));
          const sunMu0 = dot(this.cameraUp, sun).mul(r0);
          const rdSun = dot(rd, sun);
          const span = end.sub(start);
          Loop(VIEW_STEPS, ({ i }) => {
            // Samples crowd toward the camera, where the air is densest along most rays.
            const s0 = float(i).div(VIEW_STEPS);
            const s1 = float(i).add(1).div(VIEW_STEPS);
            const sm = float(i).add(0.5).div(VIEW_STEPS);
            const t = start.add(span.mul(sm.mul(sm)));
            const dt = span.mul(s1.mul(s1).sub(s0.mul(s0)));
            const r = sqrt(r0.mul(r0).add(r0.mul(mu0).mul(t).mul(2)).add(t.mul(t)));
            const height = max(r.sub(this.bottom), 0);
            const rayleigh = exp(height.div(-p.rayleighScaleHeight));
            const mie = exp(height.div(-p.mieScaleHeight));
            const ozone = max(float(1).sub(height.sub(p.ozoneCenterHeight).abs().div(p.ozoneWidth / 2)), 0);
            const rayleighScattering = vec3(...p.rayleighScattering).mul(rayleigh);
            const extinction = rayleighScattering.add(mie.mul(p.mieExtinction)).add(vec3(...p.ozoneAbsorption).mul(ozone));
            const scattering = rayleighScattering.mul(phaseR).add(mie.mul(p.mieScattering).mul(phaseM));
            const sunMu = sunMu0.add(rdSun.mul(t)).div(r);
            const source = scattering.mul(this.sunTransmittance(r, sunMu)).mul(this.sunIlluminance);
            const step = exp(extinction.mul(dt).negate());
            // Hillaire's energy-conserving integral of the source over the step.
            inscatter.addAssign(transmittance.mul(source.sub(source.mul(step))).div(extinction));
            transmittance.mulAssign(step);
          });
        });
      });

      // The sun's disc on the sky, limb-darkened: angular distance from its centre, as a sine.
      const offCentre = length(cross(rd, sun)).div(Math.sin(SUN_ANGULAR_RADIUS));
      const sky = sceneDistance.greaterThan(1e10).and(hitsGround.not()).and(dot(rd, sun).greaterThan(0));
      const limb = sqrt(max(float(1).sub(offCentre.mul(offCentre)), 0));
      const discRadiance = this.sunIlluminance.div(Math.PI * SUN_ANGULAR_RADIUS ** 2);
      const disc = sky.select(float(1), float(0)).mul(offCentre.lessThan(1).select(float(1), float(0)))
        .mul(float(0.4).add(limb.mul(0.6))).mul(discRadiance);
      return vec4(scene.mul(transmittance).add(inscatter).add(transmittance.mul(disc)), 1);
    });
    return pass();
  }
}
