# LOD Lab

This is an independent browser experiment for planet mesh generation, tile seams, skirts, culling, and quadtree selection. It has its own dependencies and does not need the game's entry point or runtime.

```sh
cd lod-lab
npm ci
npm run dev
```

Open the URL printed by Vite. Use left drag to move across the surface, right or Shift drag to turn and tilt, and the wheel to change altitude. The panel shows tile counts, LOD levels, culling, cache and worker activity. `G`, `B`, `K`, `J`, `H`, `U`, `C`, and `F` toggle visualization options; `[` and `]` change the pixel error limit.

Run `npm run check` for geometry and coverage invariants, or `npm run build` to verify the standalone page and TypeScript.

## Boundary for later integration

`src/lod/` owns the portable geometry and selection logic. It takes physical meters, a body fixed direction, and a caller supplied surface sampler. `src/app/` owns only this lab's camera, demo surface, worker pool, controls and page. The demo surface is a test fixture, not the game's planet generator. Integration can supply a different sampler and worker adapter while keeping the LOD core's tile keys, mesh buffers, and selection interface.
