import type { PlanetField } from '../fields/PlanetField';
import type { Vec3Like } from '../fields/noise';

export interface TerrainRenderSphere {
  readonly center: Vec3Like;
  readonly radius: number;
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function dot(first: Vec3Like, second: Vec3Like): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

/**
 * An explicit lower bound for the supported v1/v2 rendered radial field.
 * Ordinary negative samples draw the mean-ocean envelope. Desert/volcanic
 * raw relief is >=(-.9788-seaLevel)*maxHeight; later dry-land additions cannot
 * take positive terrain below zero. Use -1 instead and another two-meter
 * margin. The cube-grid chord bound includes its coarsest root triangles;
 * .79 is below the unsplit icosahedron's .794654 inscribed-radius ratio.
 * Unknown generator/envelope contracts disable this optional optimization.
 */
export function conservativeTerrainInnerRadius(
  field: PlanetField,
  renderRadius: number,
  rootSegments: number,
  proxyStillPresent: boolean,
): number {
  if (!field.landable || field.generatorVersion < 1 || field.generatorVersion > 2 ||
    !Number.isFinite(field.radius) || field.radius < 10_000 ||
    !Number.isFinite(field.maxHeightMeters) || field.maxHeightMeters < 0 ||
    !Number.isFinite(field.seaLevel) || !Number.isFinite(renderRadius) || renderRadius <= 0 ||
    !Number.isFinite(rootSegments) || rootSegments < 4) return 0;
  const signedDry = field.archetype === 'desert' || field.archetype === 'volcanic';
  const minimumHeight = (signedDry ? Math.min(0, (-1 - field.seaLevel) * field.maxHeightMeters) : 0) - 2;
  const minimumRadial = renderRadius * Math.max(0, 1 + minimumHeight / field.radius);
  const rootChordRatio = Math.cos(2 * Math.atan(Math.SQRT2 / Math.floor(rootSegments)));
  const topologyRatio = Math.min(rootChordRatio, proxyStillPresent ? .79 : .99);
  return Math.max(0, minimumRadial * topologyRatio - renderRadius * .000_001);
}

/**
 * A bounding sphere is hidden only if it lies wholly inside the real inner
 * sphere's shadow cone AND wholly beyond the tangent-point plane. This tests
 * the entire uploaded bound, not a tile center or nominal planetary horizon.
 */
export function terrainSphereOccludedByBody(
  sphere: TerrainRenderSphere,
  camera: Vec3Like,
  opaqueInnerRadius: number,
): boolean {
  if (!finiteVector(sphere.center) || !finiteVector(camera) ||
    !Number.isFinite(sphere.radius) || sphere.radius < 0 ||
    !Number.isFinite(opaqueInnerRadius) || opaqueInnerRadius <= 0) return false;
  const cameraDistance = Math.hypot(camera.x, camera.y, camera.z);
  if (cameraDistance <= opaqueInnerRadius) return false;
  const axis = { x: -camera.x / cameraDistance, y: -camera.y / cameraDistance, z: -camera.z / cameraDistance };
  const relative = { x: sphere.center.x - camera.x, y: sphere.center.y - camera.y, z: sphere.center.z - camera.z };
  const along = dot(relative, axis);
  const perpendicular = Math.sqrt(Math.max(0, dot(relative, relative) - along * along));
  const sine = opaqueInnerRadius / cameraDistance;
  const cosine = Math.sqrt(Math.max(0, 1 - sine * sine));
  const tangentPlane = cameraDistance * cosine * cosine;
  const margin = Math.max(1e-9, cameraDistance * 1e-7);
  return along - sphere.radius > tangentPlane + margin &&
    along * sine - perpendicular * cosine > sphere.radius + margin;
}

/** Circular cone conservatively contains the complete rectangular viewport. */
export function terrainSphereOutsideViewCone(
  sphere: TerrainRenderSphere,
  camera: Vec3Like,
  lookDirection: Vec3Like | undefined,
  verticalFieldOfViewDegrees: number,
  viewportAspect: number,
): boolean {
  if (!lookDirection || !finiteVector(sphere.center) || !finiteVector(camera) || !finiteVector(lookDirection) ||
    !Number.isFinite(sphere.radius) || sphere.radius < 0 ||
    !Number.isFinite(verticalFieldOfViewDegrees) || verticalFieldOfViewDegrees <= 0 || verticalFieldOfViewDegrees >= 175 ||
    !Number.isFinite(viewportAspect) || viewportAspect <= 0) return false;
  const relative = { x: sphere.center.x - camera.x, y: sphere.center.y - camera.y, z: sphere.center.z - camera.z };
  const distance = Math.hypot(relative.x, relative.y, relative.z);
  const lookLength = Math.hypot(lookDirection.x, lookDirection.y, lookDirection.z);
  if (distance <= sphere.radius || lookLength <= Number.EPSILON) return false;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(relative, lookDirection) / (distance * lookLength))));
  const verticalTangent = Math.tan(verticalFieldOfViewDegrees * Math.PI / 360);
  const viewportCone = Math.atan(verticalTangent * Math.sqrt(1 + viewportAspect * viewportAspect));
  const boundCone = Math.asin(Math.min(1, sphere.radius / distance));
  // Small guard for camera interpolation/rounding; actual renderer frustum
  // culling still supplies the final exact six-plane rejection.
  return angle > viewportCone + boundCone + .005;
}
