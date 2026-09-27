import * as THREE from 'three/webgpu';
import { asin, atan, dot, exp, float, Fn, If, length, log2, max, mix, normalize, smoothstep, sqrt, texture,
  texture3D, uniform, vec2, vec3 } from 'three/tsl';
import { shaderLoop } from './ShaderLoop';
import type { AtmosphereShading } from './AtmosphereNodes';
import type { Vec3 } from './Atmosphere';
import { buildCloudNoise, buildCloudWeather, CLOUD_BOTTOM, CLOUD_EXTINCTION, CLOUD_TOP,
  DEFAULT_CLOUD_COVERAGE, DETAIL_PERIOD, DETAIL_SIZE, SHAPE_PERIOD, SHAPE_SIZE, WEATHER_HEIGHT, WEATHER_WIDTH } from './CloudField';

type FloatNode = THREE.Node<'float'>;
type Vec3Node = THREE.Node<'vec3'>;

/** One body-fixed density field, sampled from the ground, inside clouds and from orbit. */
export class CloudShading {
  readonly enabled = uniform(1);
  readonly coverage = uniform(DEFAULT_CLOUD_COVERAGE);
  readonly weatherOnly = uniform(0);
  readonly seaLevel = uniform(0);
  readonly shapeOrigin = uniform(new THREE.Vector3());
  readonly detailOrigin = uniform(new THREE.Vector3());
  readonly macroOrigin = uniform(new THREE.Vector3());
  readonly focalPixels = uniform(1000);
  readonly weather: THREE.DataTexture;
  readonly shape: THREE.Data3DTexture;
  readonly detail: THREE.Data3DTexture;
  readonly buildMilliseconds: number;

  constructor(readonly atmosphere: AtmosphereShading) {
    const started = performance.now();
    this.weather = new THREE.DataTexture(buildCloudWeather(), WEATHER_WIDTH, WEATHER_HEIGHT, THREE.RGBAFormat);
    this.weather.wrapS = THREE.RepeatWrapping;
    this.weather.wrapT = THREE.ClampToEdgeWrapping;
    this.weather.minFilter = this.weather.magFilter = THREE.LinearFilter;
    this.weather.generateMipmaps = false;
    this.weather.needsUpdate = true;
    const volume = (size: number, detail: boolean) => {
      const tex = new THREE.Data3DTexture(buildCloudNoise(size, detail), size, size, size);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    };
    this.shape = volume(SHAPE_SIZE, false);
    this.detail = volume(DETAIL_SIZE, true);
    this.buildMilliseconds = performance.now() - started;
  }

  update(camera: Vec3, focalPixels: number): void {
    const origin = (period: number, out: THREE.Vector3) => {
      const mod = (v: number) => ((v % period) + period) % period;
      out.set(mod(camera.x), mod(camera.y), mod(camera.z));
    };
    origin(SHAPE_PERIOD, this.shapeOrigin.value);
    origin(DETAIL_PERIOD, this.detailOrigin.value);
    origin(SHAPE_PERIOD * 16, this.macroOrigin.value);
    this.focalPixels.value = focalPixels;
  }

  /** Stable camera-relative height: (r² − R²) / (r + R), with CPU-provided camera altitude. */
  height(position: Vec3Node): FloatNode {
    const a = this.atmosphere;
    const R = float(a.params.bottomRadius);
    const r0 = R.add(a.cameraAltitude);
    const delta = a.cameraAltitude.mul(R.mul(2).add(a.cameraAltitude))
      .add(dot(a.cameraUp, position).mul(r0).mul(2)).add(dot(position, position));
    // At orbital distances the expanded quadratic cancels huge terms. The body-fixed
    // position instead stays planet-sized there; near the ground the rational form preserves centimetres.
    return a.cameraAltitude.greaterThan(50000).select(length(position.sub(a.planetCenter)).sub(R),
      delta.div(sqrt(max(R.mul(R).add(delta), 1)).add(R)));
  }

  density(position: Vec3Node, footprint: FloatNode): FloatNode {
    return Fn(() => {
      const height = this.height(position).sub(this.seaLevel);
      const density = float(0).toVar();
      If(height.greaterThan(CLOUD_BOTTOM).and(height.lessThan(CLOUD_TOP)), () => {
        const up = normalize(position.sub(this.atmosphere.planetCenter));
        const uv = vec2(atan(up.y, up.x).div(2 * Math.PI).add(0.5 + 0.5 / WEATHER_WIDTH),
          asin(up.z.clamp(-1, 1)).div(Math.PI).add(0.5).mul((WEATHER_HEIGHT - 1) / WEATHER_HEIGHT).add(0.5 / WEATHER_HEIGHT));
        const weather = texture(this.weather, uv).level(float(0)).rg;
        const coverage = smoothstep(0.3, 0.65, weather.x.add(this.coverage.sub(DEFAULT_CLOUD_COVERAGE).mul(1.5))).mul(0.9);
        // Anchor the broad banks to the shell base. Their footprint is horizontal;
        // density then tapers toward a locally varying domed top, rather than a flat slab.
        const column = position.sub(up.mul(height.sub(CLOUD_BOTTOM)));
        const macroNoise = texture3D(this.shape, column.add(this.macroOrigin).div(SHAPE_PERIOD * 16),
          log2(max(footprint.div(SHAPE_PERIOD * 16 / SHAPE_SIZE), 1)));
        const macroShape = macroNoise.b.mul(0.7).add(macroNoise.r.mul(0.3));
        const bank = smoothstep(0.15, 0.7, macroShape);
        const shapeLevel = log2(max(footprint.div(SHAPE_PERIOD / SHAPE_SIZE), 1));
        const shape = texture3D(this.shape, position.add(this.shapeOrigin).div(SHAPE_PERIOD), shapeLevel).r;
        const top = float(CLOUD_BOTTOM).add(weather.y.mul(4500).add(2000).mul(bank.mul(0.8).add(0.2))
          .mul(mix(shape, float(0.5), smoothstep(2000, 16000, footprint)).mul(0.55).add(0.45)));
        const h = height.sub(CLOUD_BOTTOM).div(top.sub(CLOUD_BOTTOM));
        const profile = smoothstep(0, 0.08, h).mul(float(1).sub(smoothstep(0.35, 1, h)));
        const cells = shape.sub(h.mul(h).mul(0.25)).sub(float(1).sub(coverage)).div(max(coverage, 0.001)).clamp(0, 1);
        const sheet = smoothstep(0.55, 0.85, coverage).mul(float(1).sub(weather.y.mul(0.6)));
        const base = mix(cells, coverage.mul(0.32), sheet);
        const detailWeight = float(1).sub(smoothstep(80, 500, footprint));
        const detail = texture3D(this.detail, position.add(this.detailOrigin).div(DETAIL_PERIOD), log2(max(footprint.div(DETAIL_PERIOD / DETAIL_SIZE), 1))).r;
        // A filtered shape value followed by a threshold loses subpixel cloud coverage.
        // Blend toward a smooth coverage moment as kilometre-scale cells become unresolved.
        const resolvedBase = mix(base, mix(coverage.pow(3).mul(0.45), coverage.mul(0.32), sheet).mul(float(1).sub(h.mul(h).mul(0.6)).clamp(0, 1)), smoothstep(2000, 16000, footprint));
        const volume = resolvedBase.mul(profile).sub(float(1).sub(detail).mul(0.16).mul(detailWeight)).clamp(0, 1)
          .mul(weather.y.mul(0.55).add(0.45)).mul(smoothstep(0.05, 0.5, bank));
        // Weather inspection keeps the same shell and lighting, with no local noise.
        density.assign(mix(volume, coverage.mul(profile).mul(0.45), this.weatherOnly));
      });
      return density;
    })();
  }

  /** Sun-ray optical depth. Five expanding samples, capped at 120 km to limit horizon-ray cost. */
  sunOpticalDepth(position: Vec3Node, footprint: FloatNode): FloatNode {
    return Fn(() => {
      const a = this.atmosphere;
      const R = float(a.params.bottomRadius);
      const height = this.height(position);
      const r = R.add(height);
      const mu = dot(normalize(position.sub(a.planetCenter)), a.sunDirection);
      const top = R.add(this.seaLevel).add(CLOUD_TOP);
      const delta = height.sub(this.seaLevel.add(CLOUD_TOP));
      const discriminant = r.mul(r).mul(mu.mul(mu)).sub(delta.mul(top.mul(2).add(delta)));
      const end = r.mul(mu).negate().add(sqrt(max(discriminant, 0))).clamp(0, 120000);
      const optical = float(0).toVar();
      shaderLoop('shadowStep', 5, i => {
        const s0 = float(i).div(5), s1 = float(i).add(1).div(5), sm = float(i).add(0.5).div(5);
        const dt = end.mul(s1.mul(s1).sub(s0.mul(s0)));
        const q = position.add(a.sunDirection.mul(end.mul(sm.mul(sm))));
        optical.addAssign(this.density(q, max(dt.mul(0.5), footprint)).mul(dt).mul(CLOUD_EXTINCTION));
      });
      return optical;
    })();
  }

  /** Approximate cloud multiple scattering: diminishing phase anisotropy and optical depth in three orders. */
  source(position: Vec3Node, rd: Vec3Node, footprint: FloatNode): Vec3Node {
    return Fn(() => {
      const a = this.atmosphere;
      const r = float(a.params.bottomRadius).add(this.height(position));
      const up = normalize(position.sub(a.planetCenter));
      const sunMu = dot(up, a.sunDirection);
      const horizonMu = sqrt(max(float(1).sub(float(a.params.bottomRadius ** 2).div(r.mul(r))), 0)).negate();
      const visible = smoothstep(horizonMu.sub(0.004654), horizonMu.add(0.004654), sunMu);
      const toSun = mix(vec3(visible), a.sunTransmittance(r, sunMu), a.enabled);
      const cosTheta = dot(rd, a.sunDirection);
      const hg = (g: number) => float((1 - g * g) / (4 * Math.PI))
        .div(float(1 + g * g).sub(cosTheta.mul(2 * g)).pow(1.5));
      const optical = this.sunOpticalDepth(position, footprint).toVar();
      const phase = hg(0.65).mul(0.85).add(hg(-0.2).mul(0.15));
      const sunlight = phase.mul(exp(optical.negate()))
        .add(hg(0.35).mul(0.35).mul(exp(optical.mul(-0.5))))
        .add(hg(0.15).mul(0.15).mul(exp(optical.mul(-0.25))))
        // Diffuse tail of higher scattering orders; restores sunlit cloud brightness
        // when the forward phase lobe points away from the camera.
        .add(exp(optical.mul(-0.3)).mul(0.02));
      const sky = a.skyIrradiance(r, sunMu).mul(a.enabled).div(Math.PI);
      return toSun.mul(sunlight).add(sky.mul(0.5).mul(exp(optical.mul(-0.35)))).add(vec3(2e-5)).mul(a.sunIlluminance).mul(0.99);
    })();
  }
}
