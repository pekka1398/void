import * as THREE from 'three/webgpu';
import { float, mix, uv, vec3 } from 'three/tsl';

import type { StarDescriptor } from '../../universe';
import type { SystemVisualTheme } from './SystemVisualTheme';

type ActualStar = Pick<
  StarDescriptor,
  'id' | 'systemId' | 'spectralType' | 'temperatureKelvin' | 'luminositySolar' | 'color'
>;

type ActualGasTheme = Pick<
  SystemVisualTheme,
  'systemId' | 'density' | 'brightness' | 'starTint' | 'dustHex'
>;

const MAXIMUM_GAS_SCATTERING = 0.072;
const MAXIMUM_CHROMATIC_CONTRIBUTION = 0.078;

interface OriginalHaloNodes {
  readonly color: ReturnType<typeof vec3>;
  readonly opacity: ReturnType<typeof float>;
}

const originalHaloNodes = new WeakMap<THREE.SpriteNodeMaterial, OriginalHaloNodes>();

export interface StellarSpaceEnvironment {
  readonly sourceId: string;
  readonly systemId: string;
  readonly spectralType: StarDescriptor['spectralType'];
  readonly temperatureKelvin: number;
  readonly luminositySolar: number;
  readonly sourceColorHex: string;
  readonly gasDensity: number;
  readonly gasBrightness: number;
  readonly stellarIonization: number;
  readonly scatteringStrength: number;
  readonly chromaticContribution: number;
  readonly scatteringColorHex: string;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value)
    ? THREE.MathUtils.clamp(value, minimum, maximum)
    : minimum;
}

/**
 * Derive a star's local gas response from its actual descriptor and the same
 * real system theme as the anchored nebula. Dust never replaces its spectrum.
 */
export function deriveStellarSpaceEnvironment(
  star: ActualStar,
  theme: ActualGasTheme,
): StellarSpaceEnvironment {
  if (star.systemId !== theme.systemId) {
    throw new RangeError('Stellar gas scattering requires a star from the same actual system.');
  }

  const density = bounded(theme.density, 0, 1);
  const brightness = bounded(theme.brightness, 0, 1.4);
  const temperatureKelvin = bounded(star.temperatureKelvin, 2_000, 40_000);
  const luminositySolar = bounded(star.luminositySolar, 0, 100_000);
  const ionization = bounded((temperatureKelvin - 3_200) / 6_800, 0, 1);
  const luminousResponse = bounded(Math.log1p(luminositySolar) / Math.log(9), 0.08, 1);
  const scatteringStrength = bounded(
    density * brightness * (0.027 + ionization * 0.036) * (0.67 + luminousResponse * 0.33),
    0,
    MAXIMUM_GAS_SCATTERING,
  );
  const chromaticContribution = bounded(
    scatteringStrength * (0.9 + ionization * 0.12),
    0,
    MAXIMUM_CHROMATIC_CONTRIBUTION,
  );

  const sourceColor = new THREE.Color(star.color);
  const actualSystemSpectrum = new THREE.Color().setRGB(
    bounded(theme.starTint.r, 0, 1),
    bounded(theme.starTint.g, 0, 1),
    bounded(theme.starTint.b, 0, 1),
    THREE.SRGBColorSpace,
  );
  const physicalDust = new THREE.Color(theme.dustHex).lerp(actualSystemSpectrum, 0.44);
  const scatteringColor = sourceColor.clone().lerp(physicalDust, chromaticContribution);

  return Object.freeze({
    sourceId: star.id,
    systemId: star.systemId,
    spectralType: star.spectralType,
    temperatureKelvin,
    luminositySolar,
    sourceColorHex: sourceColor.getHexString(),
    gasDensity: density,
    gasBrightness: brightness,
    stellarIonization: ionization,
    scatteringStrength,
    chromaticContribution,
    scatteringColorHex: scatteringColor.getHexString(),
  });
}

/**
 * Shade only the existing, physically centered sixth halo of one real star.
 * Its photosphere, radius, target, true spectrum, and six draws stay intact.
 */
export function applyStellarSpaceEnvironment(
  group: THREE.Group,
  star: ActualStar,
  theme: ActualGasTheme,
): StellarSpaceEnvironment {
  const environment = deriveStellarSpaceEnvironment(star, theme);
  const halo = group.children[5];
  if (!(halo instanceof THREE.Mesh) || group.children.length !== 6) {
    throw new RangeError('The authentic six-draw stellar body has no existing scattering halo.');
  }

  const material = halo.material;
  if (!(material instanceof THREE.SpriteNodeMaterial) ||
    group.userData.spectralColor !== environment.sourceColorHex ||
    !material.colorNode || !material.opacityNode) {
    throw new RangeError('Stellar gas scattering cannot be applied to a different physical source.');
  }

  let original = originalHaloNodes.get(material);
  if (!original) {
    original = {
      color: material.colorNode as ReturnType<typeof vec3>,
      opacity: material.opacityNode as ReturnType<typeof float>,
    };
    originalHaloNodes.set(material, original);
  }

  if (environment.scatteringStrength > 0) {
    // The existing optical photosphere ends at 0.37 of its bounded halo.
    // Start outside that real disc and vanish before the same 9.4-radius edge.
    const radial = uv().sub(0.5).mul(2).length();
    const outerGas = radial.smoothstep(0.38, 0.58)
      .mul(radial.smoothstep(0.78, 0.96).oneMinus());
    const color = new THREE.Color(`#${environment.scatteringColorHex}`);
    material.colorNode = mix(
      original.color,
      vec3(color.r, color.g, color.b),
      outerGas.mul(environment.chromaticContribution),
    );
    material.opacityNode = original.opacity
      .add(outerGas.mul(environment.scatteringStrength * 0.28))
      .min(0.98);
  } else {
    material.colorNode = original.color;
    material.opacityNode = original.opacity;
  }

  material.userData.actualStellarSourceId = environment.sourceId;
  material.userData.systemGasScattering = environment.scatteringStrength;
  material.userData.stellarSpaceEnvironment = environment;
  halo.userData.actualStellarSourceId = environment.sourceId;
  halo.userData.systemGasScattering = environment.scatteringStrength;
  group.userData.actualStellarSourceId = environment.sourceId;
  group.userData.systemGasScattering = environment.scatteringStrength;
  group.userData.stellarSpaceEnvironment = environment;
  return environment;
}
