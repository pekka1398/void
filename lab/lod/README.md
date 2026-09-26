# LOD Lab

This is an independent browser experiment for planet mesh generation, tile seams, skirts, culling, and quadtree selection. It has its own dependencies and does not need the game's entry point or runtime.

The browser renderer explicitly uses Three.js's WebGL2 backend. It never switches renderer backends at runtime. An unavailable backend or an invalid geometry/LOD state stops the lab and displays an error with a stack trace.

```sh
cd lab/lod
npm ci
npm run dev
```

Open the URL printed by Vite. Left drag pans, right drag orbits the camera around the planet center, Shift + left drag turns the view, and the wheel scales camera distance from the planet center. The colored probe is the simulated ship position used for LOD distance and horizon calculations. Drag its red arrow for radius `r`, cyan arrow for polar angle `θ`, or yellow arrow for azimuth `φ`. Probe radius is measured from the planet center and can reach `r = 0`; terrain height never constrains it. The panel displays these coordinates along with tile counts, LOD levels, culling, cache and worker activity. `B` shows the real mesh triangle edges, `C` shows tile boundaries in red, and `K` enables skirts for comparison. `V` switches camera-driven LOD, `H` horizon culling; `G`, `J`, and `F` toggle the remaining visualization options; `[` and `]` scale the LOD distance thresholds, and `,` and `.` set the probe's pixel limit (below).

LOD level selection follows HolmanDev's per-level distance table and distance-to-patch test. Each threshold is scaled from the reference project's one-million-unit planet to this lab's 6371 km radius. Levels 0–2 split everywhere; from level 3 onward, a tile splits when the probe is close enough to its local square patch. The patch uses the fixed reference sphere so level decisions do not read terrain mesh data. The lab retains its existing worker scheduling, neighbor balancing, terrain generation, and seam stitching.

The viewing camera also drives LOD (`V`, on by default), with two roles:

- **Detail.** The camera runs the same distance-to-patch test with the same table, multiplied by the preset's `lodCamera.distanceScale`, and splits no tile at or past `lodCamera.maxLevel`. A tile splits if either the probe or the camera wants it, so detail forms concentric rings around each. The landing preset caps the camera at L14 (about 19 m per cell), so ground far from the probe does not grow a second L18 region.
- **Pixel limit.** The probe splits a tile only while the children's grid cells would still be at least `lodCamera.minObserverCellPixels` (2 px) at the tile's nearest point to the camera, so detail the camera cannot resolve is neither built nor drawn. From 17,000 km the probe's L18 region shrinks to the camera's own L3; from a camera 3 km above it stops at L15, and it reaches L18 only within a few hundred meters. The limit depends only on distance to the camera, so it cuts the probe's rings with the camera's rings and stays regular. The camera's own split test is not limited by it. `0` turns it off.
- **Visibility.** With a camera, horizon culling uses only the camera's horizon. Whatever the camera can see is drawn, including ground behind the probe's horizon, and the probe's own ground is not drawn when the camera cannot see it. Without a camera (`V` off), a tile is culled only below the probe's horizon, and moving the camera past it shows holes.

Horizon culling (`H`) is on by default. Its test uses the fixed cube-face tile directions, the reference occluder radius, and the declared global terrain height limit. It never reads a tile's mesh-derived height extrema or bounding sphere.

Rendered neighboring tiles differ by at most one level. At a fine-to-coarse boundary, the fine tile's edge vertices are placed on the coarse tile's rendered edge segments. Skirts are off by default so the seam can be inspected directly. Run `npm run face-table` to print the generated cross-face adjacency table.

The demo surface uses continuous 3D gradient noise with multiple scales and ridges. Heights range from zero to at most 500 km above the 6371 km reference radius, deliberately exaggerating terrain so cracks are easier to see. Terrain is sampled before edge vertices are stitched to coarser neighbors. Unbuilt tiles retain the full declared height range for culling; parent mesh samples cannot bound unseen child peaks.

The exact parameters of this visually checked seam-test planet are saved in `src/app/PlanetPresets.ts` as `SEAM_TEST_PLANET`. The same file defines `NORMAL_TERRAIN_PLANET`, which keeps the 6371 km radius, noise layout, and LOD configuration but reduces maximum height from 500 km to 12 km. The Planet selector in the lab switches between them. It reloads the page so workers, tile cache, and declared terrain bounds all start from the selected preset. The kilometer-scale preset is a scale experiment, not a calibrated Earth terrain model.

`LANDING_TEST_PLANET` uses the kilometer-scale terrain with a local L18 target: about 1.19 m per cell for its 33×33 tiles. Its finer split thresholds are confined near the probe. A configured 12 km LOD surface band lets the probe reach this level anywhere in the declared terrain height range without asking generated meshes for their heights. The original two presets have a zero band and keep their existing LOD decisions. Mesh wires and tile boundaries start hidden in the landing preset because thousands of debug line draws obscure its rendering cost; `B` and `C` still reveal them on demand. This is an exploratory LOD budget, not a claim that the current noise contains meter-scale landforms.

Run `npm run check` for geometry and coverage invariants, or `npm run build` to verify the standalone page and TypeScript. `npm run bench` times `PlanetLod.select` (walk, balance, evict) with stub tiles on scripted probe and camera paths in the landing preset, with instant builds and with 6 builds per frame; `-- --json` prints the results as JSON. It does not measure tile building or drawing.

The same scripted paths run in the browser with `?preset=landing&bench=all` (or a comma list such as `bench=ascent,low-traverse`). Each scenario first settles untimed at its first step, then records every frame: select phases, worker queue update, `TileRenderer.sync`, the CPU time of `renderAsync`, GPU time from timer queries (resolved late, so read means rather than single frames), draw calls, triangles and tile counts. After the path it holds the last step until the workers drain. The dev server appends each run to `lab-log/lod-bench.jsonl`; a page panic is copied to `lab-log/lod-panic.jsonl`. Keep the tab in the foreground while it runs. `?aa=0` turns MSAA off for comparison.

Tiles are drawn by one `BatchedMesh` (a single multi-draw), each tile a fixed-size slot placed by its instance matrix; per-level debug colors are instance colors. Debug line overlays are built only while shown.

The headless check also compares real L18 terrain vertices along every cube-face boundary, near cube corners, and across L18/L17 seams. The panel's `buffers` line reports the resident tile typed arrays and the extra CPU position/normal copies held by the renderer. It does not claim to measure JavaScript object overhead or browser GPU allocation.

## Boundary for later integration

`src/lod/` owns the portable geometry, selection and tile-building logic. It takes physical meters, a body fixed direction, and a caller supplied surface sampler. `src/app/` owns only this lab's camera, demo surface, worker entry, controls and page. The demo surface is a test fixture, not the game's planet generator.

Other labs import `src/lod/` directly (lab/landing does, through `landing/src/lodCore.ts`); changes they need are made here and must keep `npm run check` passing. The core is typechecked with `noUncheckedIndexedAccess`, as its importers are.

- `PlanetLod.select` takes `observerPositions` and an optional `camera` (`LodCamera`). A tile splits for its nearest observer or for the camera, under the camera's scale and level cap. The camera also carries `focalPixels` (viewport height over 2 tan(fov/2)) and `minObserverCellPixels`, the pixel limit on the observers' splits. With a camera, only the camera's horizon culls; without one, a tile is culled only when it is below every observer's horizon. lab/flight passes one; lab/landing passes none.
- A split tile's horizon-culled children are still built, queued after every visible tile. A rising observer's horizon keeps widening; without them, a child coming over it had no mesh, its parent (up to a whole cube face) was drawn instead, and neighbor balancing collapsed the fine ground beside it for a frame. `select` reports any such coarsening in `balanceCollapses`; the check flies an observer from the ground to 60 km and requires none.
- A split waiting for its children also requests the children of any coarser drawn neighbor, so neighbor balancing can refine that neighbor on the frame the split lands instead of collapsing it back. A tile whose children were already cached splits at once without this prefetch, so rare one-frame collapses remain; `npm run bench` counts them per scenario.
- `sphereToCube`, `tileContaining` and `tilesAround` (`TileSearch.ts`) map body-fixed points to tile keys, for callers that stream tiles around a craft.
- The sampler is called with the tile's nominal cell size (`cellMeters`: a face-centre tile's width over N − 1). A sampler may leave out detail finer than it, so coarse tiles do not alias it; the demo surface ignores it.
- Every tile carries `heights`, each vertex's surface height above the reference radius (stitched across seams like the positions), drawn as the `height` vertex attribute. `TileRenderer.setMaterial` lets a caller shade the tiles itself (lab/scenery's ground and sea); the debug shading then stops showing.
- `TileWorkerPool` takes a worker factory and a structured-cloneable surface config; the caller's worker entry calls `serveTileBuilds(config => sampler)`. The factory stays in the caller so its bundler sees the worker file.
