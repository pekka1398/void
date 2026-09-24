import { Vector3 } from 'three';
import {
  cameraFar, cameraNear, cameraProjectionMatrixInverse, cameraViewMatrix, float, getViewPosition,
  modelViewMatrix, positionView, select, uniform, vec4, viewportUV, viewZToLogarithmicDepth,
} from 'three/tsl';
import type { Node } from 'three/webgpu';

type Vector = Readonly<{ x: number; y: number; z: number }>;

/** Far unresolved bodies keep ordinary depth; normalize only near-planet math. */
export const MAX_ANALYTIC_OCEAN_DISTANCE_RADII = 8;

/** Compute before float32 upload so centimeters above an Earth-size sea survive. */
export function planetOceanObserverTerm(distanceRenderUnits: number, radiusRenderUnits: number): number {
  const altitudeRatio = (distanceRenderUnits - radiusRenderUnits) / radiusRenderUnits;
  return altitudeRatio * (2 + altitudeRatio);
}

/** CPU mirror of the native TSL near-sphere intersection, in render/view units. */
export function samplePlanetMeanSeaViewZ(pointView: Vector, centerView: Vector, radius: number): number {
  const distance = Math.hypot(pointView.x, pointView.y, pointView.z);
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(distance) || distance <= 0) return pointView.z;
  const cx = centerView.x / radius, cy = centerView.y / radius, cz = centerView.z / radius;
  const centerSquared = cx * cx + cy * cy + cz * cz;
  if (!Number.isFinite(centerSquared) || centerSquared > MAX_ANALYTIC_OCEAN_DISTANCE_RADII ** 2) return pointView.z;
  const rx = pointView.x / distance, ry = pointView.y / distance, rz = pointView.z / distance;
  const along = rx * cx + ry * cy + rz * cz;
  const c = planetOceanObserverTerm(Math.hypot(centerView.x, centerView.y, centerView.z), radius);
  // A camera in a trough must see its nearby physical mesh, not the far
  // hemisphere's sphere exit. Swimming/underwater rendering is not inferred.
  if (c <= 0) return pointView.z;
  const discriminant = along * along - c;
  if (discriminant < 0) return pointView.z;
  const root = Math.sqrt(Math.max(0, discriminant));
  const far = along + root;
  // c/(b+sqrt(D)) avoids subtracting nearly equal numbers above the sea.
  const near = far > 1e-12 ? c / far : along - root;
  // If an outside near hit rounds to zero, fail open to actual geometry;
  // choosing the far root would move a surface fragment through the planet.
  return near > 0 ? rz * near * radius : pointView.z;
}

function meanSeaViewZ(centerView: Node<'vec3'>, radius: number, observerTerm?: Node<'float'>): Node<'float'> {
  const center = centerView.div(radius);
  // The ray comes from the actual framebuffer pixel, not an interpolation of
  // each mesh's differently tessellated positions. All LODs get identical math.
  const ray = getViewPosition(viewportUV, float(0.5), cameraProjectionMatrixInverse).normalize();
  const centerSquared = center.dot(center);
  const along = ray.dot(center);
  const c = observerTerm ?? centerSquared.sub(1);
  const discriminant = along.mul(along).sub(c);
  const root = discriminant.max(0).sqrt();
  const far = along.add(root);
  const near = select(c.greaterThanEqual(0).and(far.greaterThan(0.000_000_000_001)),
    c.div(far.max(0.000_000_000_001)), along.sub(root));
  const valid = c.greaterThan(0).and(discriminant.greaterThanEqual(0)).and(near.greaterThan(0))
    .and(centerSquared.lessThanEqual(MAX_ANALYTIC_OCEAN_DISTANCE_RADII ** 2));
  return select(valid, ray.z.mul(near).mul(radius), positionView.z);
}

export interface PlanetOceanDepthNodes {
  readonly radiusRenderUnits: number;
  readonly viewZ: Node<'float'>;
  readonly logarithmicDepth: Node<'float'>;
  /** Update once from the same float64 camera-relative pose as the scene. */
  update(observerWorldPosition?: Vector): void;
}

/**
 * Every representation of a moving body uses the SAME camera-relative center
 * uniform. Deriving it separately from differently translated/tessellated
 * meshes reintroduces float32 depth disagreement near the coast.
 */
export function createPlanetOceanDepth(radiusRenderUnits: number, bodyCenterWorld: Vector3): PlanetOceanDepthNodes {
  if (!Number.isFinite(radiusRenderUnits) || radiusRenderUnits <= 0) throw new RangeError('Invalid ocean radius.');
  const center = uniform(bodyCenterWorld);
  const observerTerm = uniform(0);
  const update = (observer: Vector = { x: 0, y: 0, z: 0 }): void => {
    observerTerm.value = planetOceanObserverTerm(Math.hypot(bodyCenterWorld.x - observer.x,
      bodyCenterWorld.y - observer.y, bodyCenterWorld.z - observer.z), radiusRenderUnits);
  };
  update();
  const viewZ = meanSeaViewZ(cameraViewMatrix.mul(vec4(center, 1)).xyz, radiusRenderUnits, observerTerm);
  return Object.freeze({ radiusRenderUnits, viewZ,
    logarithmicDepth: viewZToLogarithmicDepth(viewZ, cameraNear, cameraFar), update });
}

/** Standalone/test meshes still derive their actual body center, never a fake sea lift. */
export function planetMeanSeaLogDepth(
  radiusRenderUnits: number,
  bodyPositionRenderUnits: Node<'vec3'>,
  shared?: PlanetOceanDepthNodes,
): Node<'float'> {
  if (shared) {
    if (Math.abs(shared.radiusRenderUnits - radiusRenderUnits) > Math.max(1e-9, radiusRenderUnits * 1e-10)) {
      throw new Error('Ocean depth must belong to the same real body radius.');
    }
    return shared.logarithmicDepth;
  }
  const centerView = positionView.sub(modelViewMatrix.mul(vec4(bodyPositionRenderUnits, 0)).xyz);
  return viewZToLogarithmicDepth(meanSeaViewZ(centerView, radiusRenderUnits), cameraNear, cameraFar);
}
