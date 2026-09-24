import * as THREE from 'three';
import { uniform } from 'three/tsl';
import type { UniformNode } from 'three/webgpu';

import type { CelestialLightFrame } from '../../lighting';

/** A stable graph for every actually supported single, binary, or triple system. */
export const CELESTIAL_SOURCE_SLOTS = 3 as const;

type DirectionNode = UniformNode<'vec3', THREE.Vector3>;
type ColorNode = UniformNode<'color', THREE.Color>;
type ScalarNode = UniformNode<'float', number>;
type ThreeSlots<Value> = readonly [Value, Value, Value];

export interface CelestialNodeLighting {
  /** Current real source-to-receiver directions, expressed in world coordinates. */
  readonly directions: ThreeSlots<DirectionNode>;
  /** Actual descriptor-derived linear spectral colors. */
  readonly colors: ThreeSlots<ColorNode>;
  /** Unattenuated physical irradiance relative to the Solar constant. */
  readonly irradiance: ThreeSlots<ScalarNode>;
  /** Actual finite-disc visibility above the receiver's geometric horizon. */
  readonly horizon: ThreeSlots<ScalarNode>;
  /** Luminance of each source's actual per-channel atmospheric transmission. */
  readonly transmittance: ThreeSlots<ScalarNode>;
  /** Full linear RGB transmission, retained for genuine warm atmospheric sunsets. */
  readonly transmissionColors: ThreeSlots<ColorNode>;
  /** Visible disc fraction: one means clear and zero means total eclipse. */
  readonly eclipse: ThreeSlots<ScalarNode>;
  readonly daylight: ScalarNode;
  readonly activeCount: ScalarNode;
  /** Actual descriptor IDs only. Inactive slots never invent a light source. */
  readonly sourceIds: [string | undefined, string | undefined, string | undefined];
}

export interface LegacyCelestialLighting {
  readonly directions?: readonly THREE.Vector3[];
  readonly colors?: readonly THREE.Color[];
  readonly secondaryStrength?: number;
}

const linearLuminance = (red: number, green: number, blue: number): number =>
  red * 0.2126 + green * 0.7152 + blue * 0.0722;

/**
 * Allocate the fixed node graph once. Existing binary vector/color references
 * may be reused, so old materials and weather retain their exact live identity.
 */
export function createCelestialNodeLighting(
  initial?: CelestialLightFrame,
  legacy: LegacyCelestialLighting = {},
): CelestialNodeLighting {
  const directions = [
    uniform(legacy.directions?.[0] ?? new THREE.Vector3(0, 1, 0)),
    uniform(legacy.directions?.[1] ?? new THREE.Vector3(0, 1, 0)),
    uniform(legacy.directions?.[2] ?? new THREE.Vector3(0, 1, 0)),
  ] as const;
  const colors = [
    uniform(legacy.colors?.[0] ?? new THREE.Color('#FFD986')),
    uniform(legacy.colors?.[1] ?? new THREE.Color('#FF8C78')),
    uniform(legacy.colors?.[2] ?? new THREE.Color(0, 0, 0)),
  ] as const;
  const secondary = THREE.MathUtils.clamp(legacy.secondaryStrength ?? 0, 0, 1);
  const bridge: CelestialNodeLighting = {
    directions,
    colors,
    irradiance: [uniform(1), uniform(secondary), uniform(0)],
    horizon: [uniform(1), uniform(secondary > 0 ? 1 : 0), uniform(0)],
    transmittance: [uniform(1), uniform(secondary > 0 ? 1 : 0), uniform(0)],
    transmissionColors: [
      uniform(new THREE.Color(1, 1, 1)),
      uniform(new THREE.Color(secondary > 0 ? 1 : 0, secondary > 0 ? 1 : 0, secondary > 0 ? 1 : 0)),
      uniform(new THREE.Color(0, 0, 0)),
    ],
    eclipse: [uniform(1), uniform(secondary > 0 ? 1 : 0), uniform(0)],
    daylight: uniform(1),
    activeCount: uniform(secondary > 0 ? 2 : 1),
    sourceIds: [undefined, undefined, undefined],
  };

  if (initial) updateCelestialNodeLighting(bridge, initial);
  return bridge;
}

/** Update values in place; node identity and compiled graphs never change. */
export function updateCelestialNodeLighting(
  bridge: CelestialNodeLighting,
  frame: CelestialLightFrame,
): CelestialNodeLighting {
  for (let index = 0; index < CELESTIAL_SOURCE_SLOTS; index += 1) {
    const source = frame.sources[index];
    if (!source?.active || !source.id) {
      bridge.directions[index]!.value.set(0, 1, 0);
      bridge.colors[index]!.value.setRGB(0, 0, 0);
      bridge.irradiance[index]!.value = 0;
      bridge.horizon[index]!.value = 0;
      bridge.transmittance[index]!.value = 0;
      bridge.transmissionColors[index]!.value.setRGB(0, 0, 0);
      bridge.eclipse[index]!.value = 0;
      bridge.sourceIds[index] = undefined;
      continue;
    }

    bridge.directions[index]!.value.set(
      source.directionWorld.x,
      source.directionWorld.y,
      source.directionWorld.z,
    ).normalize();
    bridge.colors[index]!.value.setRGB(
      Math.max(0, source.spectralColor.r),
      Math.max(0, source.spectralColor.g),
      Math.max(0, source.spectralColor.b),
    );
    bridge.irradiance[index]!.value = Number.isFinite(source.irradianceSolar)
      ? Math.max(0, source.irradianceSolar)
      : 0;
    bridge.horizon[index]!.value = THREE.MathUtils.clamp(source.horizonVisibility, 0, 1);
    bridge.transmissionColors[index]!.value.setRGB(
      THREE.MathUtils.clamp(source.atmosphericTransmittance.r, 0, 1),
      THREE.MathUtils.clamp(source.atmosphericTransmittance.g, 0, 1),
      THREE.MathUtils.clamp(source.atmosphericTransmittance.b, 0, 1),
    );
    bridge.transmittance[index]!.value = THREE.MathUtils.clamp(linearLuminance(
      source.atmosphericTransmittance.r,
      source.atmosphericTransmittance.g,
      source.atmosphericTransmittance.b,
    ), 0, 1);
    bridge.eclipse[index]!.value = THREE.MathUtils.clamp(source.eclipseVisibility, 0, 1);
    bridge.sourceIds[index] = source.id;
  }

  bridge.activeCount.value = THREE.MathUtils.clamp(frame.sourceCount, 0, CELESTIAL_SOURCE_SLOTS);
  bridge.daylight.value = THREE.MathUtils.clamp(frame.daylight, 0, 1);
  return bridge;
}
