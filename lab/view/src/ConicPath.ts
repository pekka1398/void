import { cross, dot, length, normalize, type Vec3 } from '../../orbit/src/orbit/Vec3';

/**
 * Points of the osculating two-body ellipse of a relative state about gm,
 * equally spaced in true anomaly from periapsis, as x,y,z triples relative to
 * the central body. Map views draw bodies' orbits this way; the vessel's path
 * is its N-body prediction instead. Open orbits have no closed path and throw.
 */
export function ellipsePoints(relativePosition: Vec3, relativeVelocity: Vec3, gm: number, count: number): Float64Array {
  if (!(gm > 0)) throw new RangeError(`ellipsePoints: gm=${gm}`);
  if (!Number.isInteger(count) || count < 3) throw new RangeError(`ellipsePoints: count=${count}`);
  const r = length(relativePosition);
  if (!(r > 0)) throw new RangeError('ellipsePoints: zero relative position');
  const v2 = dot(relativeVelocity, relativeVelocity);
  const rv = dot(relativePosition, relativeVelocity);
  const h = cross(relativePosition, relativeVelocity);
  const hLength = length(h);
  if (!(hLength > 0)) throw new RangeError('ellipsePoints: radial motion has no orbit plane');
  const k = v2 - gm / r;
  const eVector = {
    x: (k * relativePosition.x - rv * relativeVelocity.x) / gm,
    y: (k * relativePosition.y - rv * relativeVelocity.y) / gm,
    z: (k * relativePosition.z - rv * relativeVelocity.z) / gm,
  };
  const e = length(eVector);
  if (!(e < 1)) throw new RangeError(`ellipsePoints: open orbit e=${e}`);
  const semiLatusRectum = (hLength * hLength) / gm;
  // A circle has no periapsis; its points start at the current position instead.
  const p = e > 1e-12 ? normalize(eVector) : normalize(relativePosition);
  const q = normalize(cross(h, p));
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const nu = (2 * Math.PI * i) / count;
    const radius = semiLatusRectum / (1 + e * Math.cos(nu));
    const c = radius * Math.cos(nu), s = radius * Math.sin(nu);
    out[i * 3] = p.x * c + q.x * s;
    out[i * 3 + 1] = p.y * c + q.y * s;
    out[i * 3 + 2] = p.z * c + q.z * s;
  }
  return out;
}
