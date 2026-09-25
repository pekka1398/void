# Landing Lab

Standalone experiment: landing on and taking off from a rotating planet with terrain. Free flight uses the orbit lab's physics core (`../orbit/src/orbit`), imported rather than copied, so a trajectory here is the same code as there. Contacts with the ground use Rapier in the planet's rotating frame.

```sh
cd lab/landing
npm ci
npm run check      # headless checks
npm run typecheck
```

## Contracts with the other labs

- **Terrain**: `SurfaceSampler` has the same signature as lab/lod's: a unit body-fixed direction goes in, and height above the reference radius plus a colour come out. Swapping in lab/lod's terrain means passing its function. `checkTerrainContract` checks any terrain for what the rest of this lab relies on: non-unit input throws, samples are deterministic, heights and colours stay in bounds, and a 1 cm step never changes the height by 1 m or more. It runs on this lab's terrain now, and should run on lab/lod's when that terrain is swapped in.
- **Tiles**: collision tiles use lab/lod's cube-sphere (face frames, tangent warp, `face/level/x/y` keys), reimplemented here, so a collision tile and a rendered tile with the same key cover the same ground. One fixed level is used (about 300 m tiles); there is no LOD.
- **Physics**: the orbit lab's core is used as is. Anything it needs for landing is added there, and the orbit lab's checks must keep passing.
- **Axes**: body-fixed axes follow the orbit lab (z = spin axis, x = prime meridian). If lab/lod's axes differ, that is one fixed rotation to apply when merging.

## Planets

- `pebble` (`src/planet/Planets.ts`): 100 km radius and a Moon-like 1.6 m/s² surface gravity, which makes it far denser than real rock. A 3.5 h spin moves the equator at 50 m/s, so rotating-frame effects are large enough to test. Placeholder hills reach up to 3 km.
- The checks also run at Earth size (6371 km), so precision problems show up early.

## Collision tiles (`src/terrain/CollisionTiles.ts`)

- A tile is a (cells + 1)² grid on the terrain with two triangles per cell, wound outward. It is built only near what can touch the ground.
- Vertices are float32 offsets from a float64 origin on the terrain at the tile centre. On an Earth-size planet, vertices are within 6 µm of the terrain.
- Shared edges are computed identically from either side. Neighbouring tiles, including three faces meeting at a cube corner, share every edge vertex to within float32 rounding (under 20 µm).
- `tilesAround(point, reach)` returns every tile touching the surface within the reach.

## Status

| Phase | Scope | State |
|---|---|---|
| P1 | Lab setup, terrain contract, collision tiles | done |
| P2 | Rapier contacts in the rotating frame; drift and rest checks | next |
| P3 | Hand-off between inertial free flight and contacts; landed state; warp | |
| P4 | Page: rendering, controls, camera frames, terrain-aware prediction | |
