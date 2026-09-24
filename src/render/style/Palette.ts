import * as THREE from 'three';

export const PALETTE = {
  void: 0x04040c,
  deepSpace: 0x090a19,
  indigo: 0x14112f,
  ultramarine: 0x171d53,
  violetShadow: 0x33145e,
  deepTeal: 0x07566b,
  turquoise: 0x0fb8a9,
  mint: 0x50f1c8,
  cyan: 0x00eaff,
  magenta: 0xff2fc9,
  violet: 0x794bff,
  amber: 0xffbd59,
  sunRed: 0xff6377,
  ivory: 0xf2eadc,
  canopy: 0x18bbaa,
  white: 0xeaf2ff,
} as const;

export function material(color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.83,
    metalness: 0.04,
    flatShading: true,
    ...options,
  });
}

export function emissive(color: number, intensity = 1) {
  return material(color, { emissive: color, emissiveIntensity: intensity, toneMapped: false });
}
