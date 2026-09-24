import { Vector3, type Material } from 'three';
import { float, positionLocal, uniform } from 'three/tsl';

import { dotVec3, lengthVec3, subVec3, type Vec3 } from '../core/Vec3';
import type { ContactSurfaceGeneration, ContactTangentFrame } from './ContactGeometry';

const IDENTITY_FRAME: ContactTangentFrame = {
  originBodyFixedMeters: { x: 0, y: 0, z: 0 },
  eastBodyFixed: { x: 1, y: 0, z: 0 },
  upBodyFixed: { x: 0, y: 1, z: 0 },
  northBodyFixed: { x: 0, y: 0, z: 1 },
};

export interface ContactRenderMaskOptions {
  frame?: ContactTangentFrame;
  originBodyFixedMeters?: Readonly<Vec3>;
  metersPerLocalUnit: number;
  edgeInsetMeters?: number;
}

const nodeKeyedLegacyMaterials = new WeakSet<Material>();

/**
 * Three r185's legacy-material cache reduces object-valued properties to `{}`.
 * Two Lambert materials with different custom TSL masks can consequently share
 * the first mask's uniform bindings. Native node materials already include
 * their graph identities; give the older surface materials the same guarantee.
 */
export function useNodeAwareMaterialCacheKey(material: Material): void {
  if ((material as Material & { isNodeMaterial?: boolean }).isNodeMaterial || nodeKeyedLegacyMaterials.has(material)) return;
  const previous = material.customProgramCacheKey;
  material.customProgramCacheKey = function (): string {
    const nodes = Object.entries(this)
      .filter(([name, value]) => !name.startsWith('_') && value?.isNode === true)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}:${value.getCacheKey()}`);
    return `${previous.call(this)}|tsl:${nodes.join('|')}`;
  };
  material.userData.nodeAwareProgramCacheKey = true;
  nodeKeyedLegacyMaterials.add(material);
  material.needsUpdate = true;
}

/** Two bounded TSL cutouts, expressed relative to the mesh's small local origin. */
export function createContactRenderMask() {
  const slots = Array.from({ length: 2 }, () => ({
    center: uniform(new Vector3()),
    east: uniform(new Vector3(1, 0, 0)),
    up: uniform(new Vector3(0, 1, 0)),
    north: uniform(new Vector3(0, 0, 1)),
    originRadius: uniform(1),
    angularHalfWidth: uniform(0),
    enabled: uniform(0),
  }));
  let node = float(1).greaterThan(0);
  for (const slot of slots) {
    const relative = positionLocal.sub(slot.center);
    // The CPU grid exists only on the front hemisphere. Cross-multiplying its
    // gnomonic bounds avoids a unit-sensitive reciprocal clamp and cannot cut
    // a second square out of the planet's far side.
    const facing = slot.originRadius.add(relative.dot(slot.up));
    const bound = facing.mul(slot.angularHalfWidth);
    const inside = slot.enabled.greaterThan(0.5)
      .and(facing.greaterThan(0))
      .and(relative.dot(slot.east).abs().lessThan(bound))
      .and(relative.dot(slot.north).abs().lessThan(bound));
    node = node.and(inside.not());
  }
  return {
    node,
    set(
      generations: readonly ContactSurfaceGeneration[],
      options: ContactRenderMaskOptions,
    ): void {
      const frame = options.frame ?? { ...IDENTITY_FRAME, originBodyFixedMeters: options.originBodyFixedMeters ?? IDENTITY_FRAME.originBodyFixedMeters };
      const scale = Math.max(Number.EPSILON, options.metersPerLocalUnit);
      const localAxis = (value: Readonly<Vec3>): Vector3 => new Vector3(
        dotVec3(value, frame.eastBodyFixed), dotVec3(value, frame.upBodyFixed), dotVec3(value, frame.northBodyFixed),
      );
      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index]!;
        const generation = generations[index];
        slot.enabled.value = generation ? 1 : 0;
        if (!generation) continue;
        const center = subVec3(generation.originBodyFixedMeters, frame.originBodyFixedMeters);
        slot.center.value.copy(localAxis(center)).multiplyScalar(1 / scale);
        slot.east.value.copy(localAxis(generation.eastBodyFixed));
        slot.up.value.copy(localAxis(generation.upBodyFixed));
        slot.north.value.copy(localAxis(generation.northBodyFixed));
        slot.originRadius.value = lengthVec3(generation.originBodyFixedMeters) / scale;
        slot.angularHalfWidth.value = Math.max(0, generation.radiusMeters - (options.edgeInsetMeters ?? 0.05))
          / generation.bodyRadiusMeters;
      }
    },
    /** CPU mirror of these exact presentation uniforms; never collision/readiness authority. */
    isVisibleAtLocal(position: Readonly<Vec3>): boolean {
      return slots.every((slot) => {
        if (slot.enabled.value <= 0.5) return true;
        const relative = subVec3(position, slot.center.value);
        const facing = slot.originRadius.value + dotVec3(relative, slot.up.value);
        const bound = facing * slot.angularHalfWidth.value;
        return facing <= 0 || Math.abs(dotVec3(relative, slot.east.value)) >= bound ||
          Math.abs(dotVec3(relative, slot.north.value)) >= bound;
      });
    },
  };
}

export type ContactRenderMask = ReturnType<typeof createContactRenderMask>;
