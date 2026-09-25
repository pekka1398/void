# LOD Lab

This is an independent browser experiment for planet mesh generation, tile seams, skirts, culling, and quadtree selection. It has its own dependencies and does not need the game's entry point or runtime.

The browser renderer explicitly uses Three.js's WebGL2 backend. It never switches renderer backends at runtime. An unavailable backend or an invalid geometry/LOD state stops the lab and displays an error with a stack trace.

```sh
cd lab/lod
npm ci
npm run dev
```

Open the URL printed by Vite. Left drag pans, right drag orbits the camera around the planet center, Shift + left drag turns the view, and the wheel scales camera distance from the planet center. The colored probe is the simulated ship position used for LOD distance and horizon calculations. Drag its red arrow for radius `r`, cyan arrow for polar angle `θ`, or yellow arrow for azimuth `φ`. Probe radius is measured from the planet center and can reach `r = 0`; terrain height never constrains it. The panel displays these coordinates along with tile counts, LOD levels, culling, cache and worker activity. `B` shows the real mesh triangle edges, `C` shows tile boundaries in red, and `K` enables skirts for comparison. `G`, `J`, `H`, and `F` toggle the remaining visualization options; `[` and `]` scale the LOD distance thresholds.

LOD level selection follows HolmanDev's per-level distance table and distance-to-patch test. Each threshold is scaled from the reference project's one-million-unit planet to this lab's 6371 km radius. Levels 0–2 split everywhere; from level 3 onward, a tile splits when the probe is close enough to its local square patch. The patch uses the fixed reference sphere so level decisions do not read terrain mesh data or the viewing camera. The lab retains its existing worker scheduling, neighbor balancing, terrain generation, and seam stitching.

Probe horizon culling is off by default. The freely movable viewing camera can see tiles that the probe cannot, so hiding tiles by the probe's horizon would create visible holes in the lab. `H` enables it only for comparison. Its horizon test uses the fixed cube-face tile directions, the reference occluder radius, and the declared global terrain height limit. It never reads a tile's mesh-derived height extrema or bounding sphere.

Rendered neighboring tiles differ by at most one level. At a fine-to-coarse boundary, the fine tile's edge vertices are placed on the coarse tile's rendered edge segments. Skirts are off by default so the seam can be inspected directly. Run `npm run face-table` to print the generated cross-face adjacency table.

The demo surface uses continuous 3D gradient noise with multiple scales and ridges. Heights range from zero to at most 500 km above the 6371 km reference radius, deliberately exaggerating terrain so cracks are easier to see. Terrain is sampled before edge vertices are stitched to coarser neighbors. Unbuilt tiles retain the full declared height range for culling; parent mesh samples cannot bound unseen child peaks.

The exact parameters of this visually checked seam-test planet are saved in `src/app/PlanetPresets.ts` as `SEAM_TEST_PLANET`. The same file defines `NORMAL_TERRAIN_PLANET`, which keeps the 6371 km radius, noise layout, and LOD configuration but reduces maximum height from 500 km to 12 km. The Planet selector in the lab switches between them. It reloads the page so workers, tile cache, and declared terrain bounds all start from the selected preset. The kilometer-scale preset is a scale experiment, not a calibrated Earth terrain model.

`LANDING_TEST_PLANET` uses the kilometer-scale terrain with a local L18 target: about 1.19 m per cell for its 33×33 tiles. Its finer split thresholds are confined near the probe. A configured 12 km LOD surface band lets the probe reach this level anywhere in the declared terrain height range without asking generated meshes for their heights. The original two presets have a zero band and keep their existing LOD decisions. Mesh wires and tile boundaries start hidden in the landing preset because thousands of debug line draws obscure its rendering cost; `B` and `C` still reveal them on demand. This is an exploratory LOD budget, not a claim that the current noise contains meter-scale landforms.

Run `npm run check` for geometry and coverage invariants, or `npm run build` to verify the standalone page and TypeScript.

The headless check also compares real L18 terrain vertices along every cube-face boundary, near cube corners, and across L18/L17 seams. The panel's `buffers` line reports the resident tile typed arrays and the extra CPU position/normal copies held by the renderer. It does not claim to measure JavaScript object overhead or browser GPU allocation.

## Boundary for later integration

`src/lod/` owns the portable geometry and selection logic. It takes physical meters, a body fixed direction, and a caller supplied surface sampler. `src/app/` owns only this lab's camera, demo surface, worker pool, controls and page. The demo surface is a test fixture, not the game's planet generator. Integration can supply a different sampler and worker adapter while keeping the LOD core's tile keys, mesh buffers, and selection interface.
