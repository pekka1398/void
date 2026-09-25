import type { Vec3 } from '../orbitCore';
import type { Terrain } from './Surface';

/** One violated rule of the terrain contract. */
export interface ContractFailure { rule: string; detail: string }

/** Deterministic directions spread over the sphere (Fibonacci lattice). */
export function latticeDirections(count: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - z * z);
    out.push({ x: Math.cos(golden * i) * r, y: Math.sin(golden * i) * r, z });
  }
  return out;
}

/**
 * Checks any terrain against the contract every consumer (collision tiles,
 * rendering, impact prediction) relies on. Run on this lab's terrain now and
 * on lab/lod's terrain when it is swapped in.
 * - non-unit directions throw;
 * - the same direction always gives the same sample;
 * - heights stay in [0, maxHeightMeters] and colours in [0, 1];
 * - no jumps: a 1 cm step along the surface changes the height by < 1 m.
 */
export function checkTerrainContract(terrain: Terrain, samples = 20_000): ContractFailure[] {
  const failures: ContractFailure[] = [];
  const fail = (rule: string, detail: string) => { if (failures.length < 20) failures.push({ rule, detail }); };
  for (const bad of [{ x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 1 }]) {
    let threw = false;
    try { terrain.sample(bad); } catch { threw = true; }
    if (!threw) fail('non-unit direction throws', JSON.stringify(bad));
  }
  const step = 0.01 / terrain.radiusMeters;
  for (const d of latticeDirections(samples)) {
    const a = terrain.sample(d);
    const b = terrain.sample({ ...d });
    if (a.heightMeters !== b.heightMeters || a.color.some((c, i) => c !== b.color[i])) fail('deterministic', JSON.stringify(d));
    if (!(a.heightMeters >= 0 && a.heightMeters <= terrain.maxHeightMeters)) fail('height bounds', `${a.heightMeters} m at ${JSON.stringify(d)}`);
    if (a.color.length !== 3 || a.color.some((c) => !(c >= 0 && c <= 1))) fail('colour bounds', JSON.stringify(a.color));
    // A tangent step of 1 cm.
    const t = Math.abs(d.z) < 0.9 ? { x: -d.y, y: d.x, z: 0 } : { x: 0, y: -d.z, z: d.y };
    const tl = Math.hypot(t.x, t.y, t.z);
    const n = { x: d.x + (t.x / tl) * step, y: d.y + (t.y / tl) * step, z: d.z + (t.z / tl) * step };
    const nl = Math.hypot(n.x, n.y, n.z);
    const near = terrain.sample({ x: n.x / nl, y: n.y / nl, z: n.z / nl });
    if (!(Math.abs(near.heightMeters - a.heightMeters) < 1)) fail('continuity', `${a.heightMeters} -> ${near.heightMeters} m over 1 cm at ${JSON.stringify(d)}`);
  }
  return failures;
}
