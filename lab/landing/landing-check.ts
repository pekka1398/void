import { distance, type Vec3 } from './src/orbitCore';
import { pebble } from './src/planet/Planets';
import { buildCollisionTile, levelForTileSize, tileContaining, tileId, tilesAround, type CollisionTile } from './src/terrain/CollisionTiles';
import { cubeToSphere, sphereToCube } from './src/terrain/CubeSphere';
import { hillsTerrain } from './src/terrain/HillsTerrain';
import { checkTerrainContract, latticeDirections } from './src/terrain/SurfaceContract';

declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}
const fmt = (x: number) => x.toExponential(2);

const TILE_SIZE_METERS = 300;
const CELLS = 32;
const small = pebble().terrain;
const earthSize = hillsTerrain({ name: 'Earth-size hills', radiusMeters: 6.371e6, maxHeightMeters: 8000, wavelengthMeters: 40_000, octaves: 8 });

// --- Terrain contract --------------------------------------------------------------
for (const terrain of [small, earthSize]) {
  const broken = checkTerrainContract(terrain);
  check(`terrain contract: ${terrain.name}`, broken.length === 0,
    broken.length === 0 ? '20,000 directions: unit input enforced, deterministic, bounded, continuous' : broken.map((f) => `${f.rule}: ${f.detail}`).join('; '));
}

// --- Cube sphere ---------------------------------------------------------------------
{
  let worst = 0;
  for (const d of latticeDirections(5000)) {
    const { face, u, v } = sphereToCube(d);
    worst = Math.max(worst, distance(cubeToSphere(face, u, v), d));
  }
  check('cube sphere round trip', worst < 1e-14, `worst ${fmt(worst)}`);
}

function absolute(tile: CollisionTile, i: number): Vec3 {
  const v = tile.vertices;
  return { x: tile.origin.x + v[i * 3]!, y: tile.origin.y + v[i * 3 + 1]!, z: tile.origin.z + v[i * 3 + 2]! };
}

for (const terrain of [small, earthSize]) {
  const level = levelForTileSize(terrain.radiusMeters, TILE_SIZE_METERS);
  const label = `${terrain.name}, level ${level}`;

  // --- Tiles: determinism and heights ----------------------------------------------
  {
    const key = tileContaining({ x: 0.3, y: -0.5, z: Math.sqrt(1 - 0.34) }, level);
    const a = buildCollisionTile(key, terrain, CELLS);
    const b = buildCollisionTile({ ...key }, terrain, CELLS);
    const same = a.vertices.every((x, i) => x === b.vertices[i]) && a.indices.every((x, i) => x === b.indices[i]) && a.origin.x === b.origin.x;
    let worstHeight = 0;
    let span = 0;
    for (let i = 0; i < a.vertices.length / 3; i += 1) {
      const p = absolute(a, i);
      const r = Math.hypot(p.x, p.y, p.z);
      const h = terrain.sample({ x: p.x / r, y: p.y / r, z: p.z / r }).heightMeters;
      worstHeight = Math.max(worstHeight, Math.abs(r - terrain.radiusMeters - h));
      span = Math.max(span, Math.hypot(a.vertices[i * 3]!, a.vertices[i * 3 + 1]!, a.vertices[i * 3 + 2]!));
    }
    check(`tile determinism and heights (${label})`, same && worstHeight < 1e-3,
      `${tileId(key)}: rebuilt bit-identical; vertices within ${fmt(worstHeight)} m of the terrain (float32 relative to a tile origin, farthest vertex ${span.toFixed(0)} m from it)`);
  }

  // --- Seams, including a cube corner where three faces meet ------------------------
  for (const [where, point] of [['cube corner', { x: 1, y: 1, z: 1 }], ['face interior', { x: 0.2, y: 0.9, z: -0.3 }]] as const) {
    const l = Math.hypot(point.x, point.y, point.z);
    const centre = { x: (point.x / l) * terrain.radiusMeters, y: (point.y / l) * terrain.radiusMeters, z: (point.z / l) * terrain.radiusMeters };
    const tiles = tilesAround(centre, 3 * TILE_SIZE_METERS, level, terrain.radiusMeters).map((k) => buildCollisionTile(k, terrain, CELLS));
    const faces = new Set(tiles.map((t) => t.key.face));
    let unmatched = 0, tested = 0, worstGap = 0;
    const side = CELLS + 1;
    for (const tile of tiles) {
      for (let j = 0; j <= CELLS; j += 1) {
        for (let i = 0; i <= CELLS; i += 1) {
          if (i !== 0 && j !== 0 && i !== CELLS && j !== CELLS) continue;
          const p = absolute(tile, j * side + i);
          const r = Math.hypot(p.x, p.y, p.z);
          // Only edges well inside the tested patch have every neighbour loaded.
          if (distance({ x: (p.x / r) * terrain.radiusMeters, y: (p.y / r) * terrain.radiusMeters, z: (p.z / r) * terrain.radiusMeters }, centre) > 1.5 * TILE_SIZE_METERS) continue;
          tested += 1;
          let best = Infinity;
          for (const other of tiles) {
            if (other === tile) continue;
            for (let k = 0; k < other.vertices.length / 3; k += 1) best = Math.min(best, distance(p, absolute(other, k)));
          }
          if (best > 1e-4) unmatched += 1;
          else worstGap = Math.max(worstGap, best);
        }
      }
    }
    check(`seams at a ${where} (${label})`, unmatched === 0 && tested > 0,
      `${tiles.length} tiles on ${faces.size} face(s), ${tested - unmatched}/${tested} edge vertices shared within 0.1 mm, largest gap ${fmt(worstGap)} m (float32 rounding)`);
  }

  // --- Coverage of tilesAround --------------------------------------------------------
  {
    const reach = 500;
    let missing = 0, points = 0;
    for (const d of latticeDirections(40)) {
      const centre = { x: d.x * terrain.radiusMeters, y: d.y * terrain.radiusMeters, z: d.z * terrain.radiusMeters };
      const ids = new Set(tilesAround(centre, reach, level, terrain.radiusMeters).map(tileId));
      const t1n = Math.abs(d.z) < 0.9 ? { x: -d.y, y: d.x, z: 0 } : { x: 0, y: -d.z, z: d.y };
      const l1 = Math.hypot(t1n.x, t1n.y, t1n.z);
      const t1 = { x: t1n.x / l1, y: t1n.y / l1, z: t1n.z / l1 };
      const t2 = { x: d.y * t1.z - d.z * t1.y, y: d.z * t1.x - d.x * t1.z, z: d.x * t1.y - d.y * t1.x };
      for (let k = 0; k < 64; k += 1) {
        const angle = (k / 64) * 2 * Math.PI, s = (reach * ((k % 8) + 1)) / 8 / terrain.radiusMeters;
        const p = { x: d.x + (t1.x * Math.cos(angle) + t2.x * Math.sin(angle)) * s, y: d.y + (t1.y * Math.cos(angle) + t2.y * Math.sin(angle)) * s, z: d.z + (t1.z * Math.cos(angle) + t2.z * Math.sin(angle)) * s };
        points += 1;
        if (!ids.has(tileId(tileContaining(p, level)))) missing += 1;
      }
    }
    check(`tilesAround covers its reach (${label})`, missing === 0, `${points} surface points within ${reach} m of 40 centres, ${missing} outside the returned tiles`);
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
