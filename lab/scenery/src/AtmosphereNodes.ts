import * as THREE from 'three/webgpu';
import {
  Break, cross, dot, exp, float, Fn, If, int, length, max, min, mix, normalize, outputStruct, property, smoothstep, sqrt, texture, uniform, vec2, vec3, vec4,
  getViewPosition, logarithmicDepthToViewZ, screenUV,
} from 'three/tsl';
import {
  buildTransmittanceTable, TRANSMITTANCE_HEIGHT, TRANSMITTANCE_WIDTH, type AtmosphereParams, type Vec3,
} from './Atmosphere';
import {
  buildIrradianceTable, buildMultipleScatteringTable, IRRADIANCE_HEIGHT, IRRADIANCE_WIDTH, MULTIPLE_SCATTERING_SIZE,
} from './SkyTables';

import { shaderLoop } from './ShaderLoop';
import type { CloudShading } from './CloudNodes';
import { CLOUD_BOTTOM, CLOUD_TOP, CLOUD_EXTINCTION } from './CloudField';

type FloatNode = THREE.Node<'float'>;
type Vec3Node = THREE.Node<'vec3'>;

/** The Sun seen from Aurelia's distance (1 AU): angular radius, radians. */
export const SUN_ANGULAR_RADIUS = 0.004654;
/** Samples along each view ray through the air. */
const VIEW_STEPS = 32;
const BODY_FIXED_RENDER = new THREE.Matrix4();

/**
 * The atmosphere on the GPU. Two users:
 *
 * - `sunTransmittance`, for the ground's shading: how much sunlight reaches a
 *   point through the air, from the transmittance table.
 * - `transport`, a full-resolution pass over the rendered scene: every pixel's
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
  /** Hillaire's multiple-scattering source Ψ and the sky's irradiance on level ground (src/SkyTables.ts). */
  readonly multipleScatteringTable: THREE.DataTexture;
  readonly irradianceTable: THREE.DataTexture;
  /** CPU time spent building the three tables at start-up, milliseconds. */
  readonly buildMilliseconds: number;
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
  /** 0 leaves out multiple scattering, for comparison. */
  readonly multipleEnabled = uniform(1);
  /** A caller with its own correctly positioned Sun mesh can disable the sky disc. */
  readonly sunDiscEnabled = uniform(1);
  /** Camera matrices for the composite pass, whose own camera is the full-screen quad's. */
  readonly projectionInverse = uniform(new THREE.Matrix4());
  readonly cameraRotation = uniform(new THREE.Matrix4());
  readonly cameraNear = uniform(1);
  readonly cameraFar = uniform(2);

  private readonly bottom: FloatNode;
  private readonly top: FloatNode;
  private readonly horizon: FloatNode;

  constructor(readonly params: AtmosphereParams) {
    const started = performance.now();
    const transmittance = buildTransmittanceTable(params);
    const multiple = buildMultipleScatteringTable(params, transmittance);
    const irradiance = buildIrradianceTable(params, transmittance, multiple);
    this.buildMilliseconds = performance.now() - started;
    this.transmittanceTable = halfFloatTexture(transmittance, TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT);
    this.multipleScatteringTable = halfFloatTexture(multiple, MULTIPLE_SCATTERING_SIZE, MULTIPLE_SCATTERING_SIZE);
    this.irradianceTable = halfFloatTexture(irradiance, IRRADIANCE_WIDTH, IRRADIANCE_HEIGHT);
    this.bottom = float(params.bottomRadius);
    this.top = float(params.topRadius);
    this.horizon = float(Math.sqrt(params.topRadius ** 2 - params.bottomRadius ** 2));
  }

  /**
   * Per frame. `cameraBodyFixed` is the camera's body-fixed position (planet centre at the origin), metres.
   */
  update(cameraBodyFixed: Vec3, sun: Vec3, camera: THREE.PerspectiveCamera, renderToBody = BODY_FIXED_RENDER): void {
    const r = Math.hypot(cameraBodyFixed.x, cameraBodyFixed.y, cameraBodyFixed.z);
    if (!(r > 0)) throw new RangeError(`AtmosphereShading.update: camera at the planet centre`);
    const sunLength = Math.hypot(sun.x, sun.y, sun.z);
    if (Math.abs(sunLength - 1) > 1e-9) throw new RangeError(`AtmosphereShading.update: sun direction length ${sunLength}`);
    this.planetCenter.value.set(-cameraBodyFixed.x, -cameraBodyFixed.y, -cameraBodyFixed.z);
    this.cameraUp.value.set(cameraBodyFixed.x / r, cameraBodyFixed.y / r, cameraBodyFixed.z / r);
    this.cameraAltitude.value = r - this.params.bottomRadius;
    this.sunDirection.value.set(sun.x, sun.y, sun.z);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
    // The transport ray must share the body-fixed axes of the atmosphere and cloud noise.
    this.cameraRotation.value.multiplyMatrices(renderToBody, camera.matrixWorld);
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
    // Marching branches differ per pixel: implicit texture derivatives are undefined there.
    return texture(this.transmittanceTable, uv).level(float(0)).rgb.mul(visible);
  }

  /** (height, sun zenith cosine) coordinates of the multiple-scattering and irradiance tables; see SkyTables.ts. */
  private skyTableUv(r: FloatNode, sunMu: FloatNode, width: number, height: number): THREE.Node<'vec2'> {
    const depth = this.params.topRadius - this.params.bottomRadius;
    const x = sunMu.clamp(-1, 1).add(1).mul(0.5);
    const y = sqrt(r.sub(this.bottom).clamp(0, depth).div(depth));
    return vec2(x.mul((width - 1) / width).add(0.5 / width), y.mul((height - 1) / height).add(0.5 / height));
  }

  /** Light scattered twice or more, per unit scattering coefficient and sun illuminance. */
  multipleScattering(r: FloatNode, sunMu: FloatNode): Vec3Node {
    return texture(this.multipleScatteringTable, this.skyTableUv(r, sunMu, MULTIPLE_SCATTERING_SIZE, MULTIPLE_SCATTERING_SIZE)).level(float(0)).rgb;
  }

  /** Sky irradiance (without the sun's beam) on level ground at radius r, per unit sun illuminance. */
  skyIrradiance(r: FloatNode, sunMu: FloatNode): Vec3Node {
    return texture(this.irradianceTable, this.skyTableUv(r, sunMu, IRRADIANCE_WIDTH, IRRADIANCE_HEIGHT)).level(float(0)).rgb;
  }

  /** Joint air/cloud transport, written once into two full-resolution render attachments. */
  transport(depth: ReturnType<typeof texture>, clouds: CloudShading) {
    const lightOutput = property('vec4');
    const transmissionOutput = property('vec4');
    const p = this.params;
    const pass = Fn(() => {
      const viewZ = logarithmicDepthToViewZ(depth.x, this.cameraNear, this.cameraFar);
      const viewDirection = normalize(getViewPosition(screenUV, float(0.5), this.projectionInverse));
      // Distance along the ray to what was drawn; sky pixels read about the far plane.
      const sceneDistance = viewZ.div(viewDirection.z);
      const rd = normalize(this.cameraRotation.mul(vec4(viewDirection, 0)).xyz);
      const sun = this.sunDirection;

      const r0 = this.bottom.add(this.cameraAltitude);
      const mu0 = dot(this.cameraUp, rd);
      const orbital = this.cameraAltitude.greaterThan(50000);
      const projection = orbital.select(dot(this.planetCenter.negate(), rd), r0.mul(mu0));
      const closest = this.planetCenter.negate().sub(rd.mul(projection));
      const closestSquared = dot(closest, closest);
      // r0² − R², kept exact near the ground: altitude (2R + altitude).
      const aboveGround = this.cameraAltitude.mul(this.bottom.mul(2).add(this.cameraAltitude));
      const groundDiscriminant = orbital.select(this.bottom.mul(this.bottom).sub(closestSquared),
        r0.mul(r0).mul(mu0.mul(mu0)).sub(aboveGround));
      const hitsGround = mu0.lessThan(0).and(groundDiscriminant.greaterThanEqual(0));
      const groundDistance = projection.negate().sub(sqrt(max(groundDiscriminant, 0)));
      const topDiscriminant = orbital.select(this.top.mul(this.top).sub(closestSquared),
        r0.mul(r0).mul(mu0.mul(mu0).sub(1)).add(this.top.mul(this.top)));

      const transmittance = vec3(1, 1, 1).toVar();
      const inscatter = vec3(0, 0, 0).toVar();
      If(this.enabled.greaterThan(0).or(clouds.enabled.greaterThan(0)).and(topDiscriminant.greaterThan(0)), () => {
        const topNear = projection.negate().sub(sqrt(topDiscriminant));
        const topFar = projection.negate().add(sqrt(topDiscriminant));
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
          // A ray can meet the shell twice (near and far sides), with clear air between.
          // Split at all four shell crossings before integration, so orbit rays cannot skip a thin layer.
          const shellRoots = (shellHeight: FloatNode) => {
            const shellRadius = this.bottom.add(shellHeight);
            const h = this.cameraAltitude.sub(shellHeight);
            const discriminant = orbital.select(shellRadius.mul(shellRadius).sub(closestSquared),
              r0.mul(r0).mul(mu0.mul(mu0)).sub(h.mul(shellRadius.mul(2).add(h))));
            const root = sqrt(max(discriminant, 0));
            return { near: projection.negate().sub(root).clamp(start, end),
              far: projection.negate().add(root).clamp(start, end), discriminant };
          };
          const outer = shellRoots(clouds.seaLevel.add(CLOUD_TOP));
          const inner = shellRoots(clouds.seaLevel.add(CLOUD_BOTTOM));
          const cloudRay = clouds.enabled.greaterThan(0).and(clouds.coverage.greaterThan(0)).and(outer.discriminant.greaterThan(0));
          const b1 = cloudRay.select(outer.near, end);
          const b2 = cloudRay.select(inner.near, end);
          const b3 = cloudRay.select(inner.far, end);
          const b4 = cloudRay.select(outer.far, end);
          shaderLoop('cloudSegment', 5, segment => {
            const from = segment.equal(0).select(start, segment.equal(1).select(b1,
              segment.equal(2).select(b2, segment.equal(3).select(b3, b4))));
            const to = segment.equal(0).select(b1, segment.equal(1).select(b2,
              segment.equal(2).select(b3, segment.equal(3).select(b4, end))));
            If(to.greaterThan(from), () => {
              const midpoint = rd.mul(from.add(to).mul(0.5));
              const midHeight = clouds.height(midpoint).sub(clouds.seaLevel);
              const inCloud = cloudRay.and(midHeight.greaterThan(CLOUD_BOTTOM)).and(midHeight.lessThan(CLOUD_TOP));
              const steps = int(inCloud.select(this.cameraAltitude.lessThan(100000).select(48, 24), VIEW_STEPS));
              const span = to.sub(from).toVar();
              shaderLoop('viewStep', steps, i => {
                If(transmittance.x.max(transmittance.y).max(transmittance.z).lessThan(0.003), () => { Break(); });
                // Quadratic spacing retains short steps when the camera starts inside the cloud.
                const s0 = float(i).div(float(steps));
                const s1 = float(i).add(1).div(float(steps));
                const sm = float(i).add(0.5).div(float(steps));
                const t = from.add(span.mul(sm.mul(sm))).toVar();
                const dt = span.mul(s1.mul(s1).sub(s0.mul(s0))).toVar();
                const position = rd.mul(t).toVar();
                const height = max(clouds.height(position), 0);
                const r = this.bottom.add(height);
                const rayleigh = exp(height.div(-p.rayleighScaleHeight));
                const mie = exp(height.div(-p.mieScaleHeight));
                const ozone = max(float(1).sub(height.sub(p.ozoneCenterHeight).abs().div(p.ozoneWidth / 2)), 0);
                const rayleighScattering = vec3(...p.rayleighScattering).mul(rayleigh);
                const extinction = rayleighScattering.add(mie.mul(p.mieExtinction)).add(vec3(...p.ozoneAbsorption).mul(ozone))
                  .mul(this.enabled).toVar();
                const scattering = rayleighScattering.mul(phaseR).add(mie.mul(p.mieScattering).mul(phaseM));
                const sunMu = sunMu0.add(rdSun.mul(t)).div(r);
                const allScattering = rayleighScattering.add(mie.mul(p.mieScattering));
                const source = scattering.mul(this.sunTransmittance(r, sunMu))
                  .add(allScattering.mul(this.multipleScattering(r, sunMu).mul(this.multipleEnabled)))
                  .mul(this.sunIlluminance).mul(this.enabled).toVar();
                If(inCloud, () => {
                  const footprint = max(dt, t.div(clouds.focalPixels)).mul(2);
                  const sigma = clouds.density(position, footprint).mul(CLOUD_EXTINCTION).toVar();
                  If(sigma.greaterThan(0.000001), () => {
                    extinction.addAssign(vec3(sigma));
                    source.addAssign(clouds.source(position, rd, footprint).mul(sigma));
                  });
                });
                const step = exp(extinction.mul(dt).negate());
                // Joint air/cloud transport, in depth order. An air-only pass on top of clouds is insufficient.
                const integral = vec3(
                  extinction.x.greaterThan(1e-10).select(float(1).sub(step.x).div(max(extinction.x, 1e-10)), dt),
                  extinction.y.greaterThan(1e-10).select(float(1).sub(step.y).div(max(extinction.y, 1e-10)), dt),
                  extinction.z.greaterThan(1e-10).select(float(1).sub(step.z).div(max(extinction.z, 1e-10)), dt));
                inscatter.addAssign(transmittance.mul(source).mul(integral));
                transmittance.mulAssign(step);
              });
            });
          });
        });
      });

      lightOutput.assign(vec4(inscatter, depth.x));
      transmissionOutput.assign(vec4(transmittance, 1));
      return vec3(0);
    });
    return { evaluate: pass(), output: outputStruct(lightOutput, transmissionOutput) };
  }

  /** Full-resolution solar disc; the low-resolution transport supplies its attenuation. */
  sunDisc(depth: ReturnType<typeof texture>): Vec3Node {
    return Fn(() => {
      const viewZ = logarithmicDepthToViewZ(depth.x, this.cameraNear, this.cameraFar);
      const viewDirection = normalize(getViewPosition(screenUV, float(0.5), this.projectionInverse));
      const sceneDistance = viewZ.div(viewDirection.z);
      const rd = normalize(this.cameraRotation.mul(vec4(viewDirection, 0)).xyz);
      const sun = this.sunDirection;
      const r0 = this.bottom.add(this.cameraAltitude);
      const mu0 = dot(this.cameraUp, rd);
      const closest = this.planetCenter.negate().sub(rd.mul(dot(this.planetCenter.negate(), rd)));
      const aboveGround = this.cameraAltitude.mul(this.bottom.mul(2).add(this.cameraAltitude));
      const groundDiscriminant = this.cameraAltitude.greaterThan(50000).select(
        this.bottom.mul(this.bottom).sub(dot(closest, closest)), r0.mul(r0).mul(mu0.mul(mu0)).sub(aboveGround));
      const hitsGround = mu0.lessThan(0).and(groundDiscriminant.greaterThanEqual(0));
      const offCentre = length(cross(rd, sun)).div(Math.sin(SUN_ANGULAR_RADIUS));
      const sky = sceneDistance.greaterThan(1e10).and(hitsGround.not()).and(dot(rd, sun).greaterThan(0));
      const limb = sqrt(max(float(1).sub(offCentre.mul(offCentre)), 0));
      const discRadiance = this.sunIlluminance.div(Math.PI * SUN_ANGULAR_RADIUS ** 2);
      const disc = sky.select(float(1), float(0)).mul(offCentre.lessThan(1).select(float(1), float(0)))
        .mul(float(0.4).add(limb.mul(0.6))).mul(discRadiance);
      return vec3(disc.mul(this.sunDiscEnabled));
    })();
  }
}

function halfFloatTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i += 1) half[i] = THREE.DataUtils.toHalfFloat(data[i]!);
  // Half floats filter linearly on every WebGL2 device; float textures need an extension.
  const texture = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
