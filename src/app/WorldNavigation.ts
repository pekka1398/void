import * as THREE from 'three';

export interface NavigationViewport {
  width: number;
  height: number;
  padding?: number;
}

export interface ProjectedNavigationTarget {
  x: number;
  y: number;
  visible: boolean;
  offscreen: boolean;
  bearingRadians: number;
  distanceToCamera: number;
}

/**
 * Project an actual camera-relative simulation body; offscreen indicators are
 * derived from its true direction rather than invented UI-only destinations.
 */
export function projectNavigationTarget(
  camera: THREE.PerspectiveCamera,
  worldPosition: THREE.Vector3,
  viewport: NavigationViewport,
): ProjectedNavigationTarget | undefined {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const padding = Math.max(28, viewport.padding ?? 76);
  const distanceToCamera = worldPosition.length();
  if (!Number.isFinite(distanceToCamera) || distanceToCamera < 0.000_001) return undefined;

  camera.updateMatrixWorld();
  const view = worldPosition.clone().applyMatrix4(camera.matrixWorldInverse);
  const inFront = view.z < -0.000_01;
  const projected = worldPosition.clone().project(camera);
  let horizontal = projected.x;
  let vertical = projected.y;

  if (!inFront) {
    horizontal = -horizontal;
    vertical = -vertical;
    if (Math.abs(horizontal) + Math.abs(vertical) < 0.02) vertical = -1;
  }

  if (!Number.isFinite(horizontal) || !Number.isFinite(vertical)) return undefined;

  const visible = inFront && Math.abs(horizontal) <= 0.96 && Math.abs(vertical) <= 0.94;
  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const bearingRadians = Math.atan2(-vertical, horizontal);

  if (visible) {
    return {
      x: centerX + horizontal * centerX,
      y: centerY - vertical * centerY,
      visible: true,
      offscreen: false,
      bearingRadians,
      distanceToCamera,
    };
  }

  const maxX = Math.max(1, centerX - padding);
  const maxY = Math.max(1, centerY - padding);
  const directionLength = Math.hypot(horizontal, vertical) || 1;
  const unitX = horizontal / directionLength;
  const unitY = -vertical / directionLength;
  const edgeScale = Math.min(
    Math.abs(unitX) < 0.000_01 ? Number.POSITIVE_INFINITY : maxX / Math.abs(unitX),
    Math.abs(unitY) < 0.000_01 ? Number.POSITIVE_INFINITY : maxY / Math.abs(unitY),
  );

  return {
    x: centerX + unitX * edgeScale,
    y: centerY + unitY * edgeScale,
    visible: false,
    offscreen: true,
    bearingRadians,
    distanceToCamera,
  };
}

export function apparentRadiusPixels(
  camera: THREE.PerspectiveCamera,
  radiusRenderUnits: number,
  distanceRenderUnits: number,
  viewportHeight: number,
): number {
  if (distanceRenderUnits <= 0 || radiusRenderUnits <= 0) return 0;
  const halfVerticalFov = THREE.MathUtils.degToRad(camera.fov) * 0.5;
  return Math.min(
    viewportHeight,
    radiusRenderUnits / distanceRenderUnits * viewportHeight / (2 * Math.tan(halfVerticalFov)),
  );
}
