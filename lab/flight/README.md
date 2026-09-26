# Flight Lab

This is the first integration lab. It connects features that were each built and checked in their own lab:

- **lab/landing**: the two-stage rocket, with Rapier contact physics near the ground and orbit propagation in flight, plus staging, the terrain streamed by lab/lod, and the rocket visuals.
- **lab/orbit**: the N-body ephemeris of the whole solar system, reference frames and apsides.
- **lab/navball**: the attitude ball.
- **lab/view**: the single view. Zooming out from the rocket turns into the map, and the camera turns from the local vertical to the planet's north (see lab/view's decision).

The lab adds no features of its own, only the wiring. It imports those labs' code through `src/orbitCore.ts`, `src/landingCore.ts`, `src/navballCore.ts` and `src/viewCore.ts`. A change a feature needs is made in its own lab, and that lab's checks must keep passing. This is the rehearsal for putting it all together. Whether it later moves into `src/` or becomes the game itself is still open.

```sh
cd lab/flight
npm install
npm run dev        # http://127.0.0.1:5176/  (?planet=aurelia by default)
npm run check      # headless checks of the wiring
npm run typecheck
```

## The page

- **Planet.** The default is Aurelia inside the full sol system: the Sun, the planets and Selene, with a 23.4° axial tilt, all integrated as one N-body ephemeris. Its terrain is terra's placeholder hills, streamed as lab/lod tiles. `?planet=` also accepts the landing lab's lone planets (pebble, luna, terra), and `aurelia-fast`, which is Aurelia with a 2.4 h day for seeing the rotation in flight.
- **Rendering.** Everything is in the inertial ecliptic frame, relative to the upper stage, with float64 subtraction on the CPU and a logarithmic depth buffer.
  - Tiles and rocket attitudes are body-fixed. They are turned into the scene by the planet's current orientation (`FlightFrame.bodyFixedToRender`).
  - The Sun lights the scene from its real direction, and a little ambient light keeps the night side flyable.
- **Terrain observers.** lab/lod's observers are every live part, plus the camera (lab/lod's `LodCamera`). The camera splits tiles with the same table, stopping one level above the collision level, and is the only horizon for culling, so from far out the planet's face toward the camera is drawn. The rocket's own detail stops where its cells would be under 2 px on screen (lab/lod's pixel limit): with the camera near the rocket, drawn terrain equals collision terrain, and zoomed out the drawn ground coarsens while collision terrain, built separately, does not.
- **Camera.** This is lab/view's `OrbitCamera` and `viewState`, in single mode:
  - On the pad, the camera turns with the ground. In flight above about 25–76 km on Aurelia (0.004–0.012 R) it is inertial.
  - Zooming out from about 4 km (where the rocket is about 1 px) to 40 km fades in the map: orbits, labels, the rocket's forecast path and its Pe/Ap. The camera does not turn meanwhile, nor up to 400 km.
  - Then, from 400 km to 4,000 km, up turns from the local vertical to north, and the camera stops turning with the ground.
  - `Tab` or clicking a label focuses a body.
- **Map path.** It is the landing lab's coast forecast (`predictCoast`), recomputed every 2 s of simulated time. It is drawn from its inertial trajectory relative to the dominant body, and ends at the terrain.
- **Rocket.** It is sized KSP-style to reach low orbit on Aurelia, which has no atmosphere: 8.6 km/s of Δv in all.
  - Booster: 120 kN, Isp 310 s, liftoff thrust-to-weight about 2, 3.4 km/s, 101 s burn.
  - Upper stage: 20 kN, Isp 340 s, thrust-to-weight about 1.5, 5.1 km/s, 183 s burn.
  - It takes a gravity turn: climb, then pitch toward the east, which is where the ground's 450 m/s helps.
- **HUD** is laid out after KSP, in this lab's plain style:
  - Top left: mission time and time rate (1×, 5×, 20×, 100×, 200×; click or `,`/`.`).
  - Bottom left: the stages, with each part's own fuel and its vacuum Δv (the booster's counts the upper stage it pushes); the next stage is yellow, the burning one green.
  - Bottom centre: throttle, then altitude above speed in one box.
    - Click the altitude's label to switch AGL (above the ground under the rocket) and ALT (above the reference radius).
    - Click the speed's label to switch SURFACE (over the home planet's ground) and ORBIT (about the dominant body).
  - Beside the speed: lab/navball's ball, with the heading and pitch of the nose. It is drawn in the ecliptic frame, around the dominant body's local vertical and north, with grid north along its prime meridian exactly at a pole. Its prograde and retrograde markers follow the SURFACE/ORBIT switch.
  - Right: Ap, Pe and the impact, fading in with the map.
  - Top right: the dev panel (`` ` ``), collapsed at first: planet, debug overlays, focus, camera and tiles.
  - Bottom right: the keys (`F1`).
- **Controls** are the landing lab's:
  - `Space` stages, `Shift`/`Ctrl` throttle, `X` cuts.
  - `WASDQE` steer, `P` pauses, `R` resets.
- **Log.** The dev server logs each session to `lab-log/flight.jsonl`: once per second the mode, altitude, camera distance, map weight, co-rotation, tiles, and frame, physics, LOD and draw times, plus focus changes and resets.

## LOD profiling

The **Draw terrain (profiling)** checkbox in the dev panel hides terrain draws while leaving LOD selection, tile workers, and tile object synchronization running. At a fixed camera and vessel position, wait until `queued` is zero, then compare several `flight-sample` records with the checkbox on and off. The `terrain-visibility` events mark each change.

`perf` separates LOD selection (`selectMs`, with `traverseMs`, `balanceMs`, and `evictMs`), worker queue maintenance (`queueMs`), tile geometry synchronization (`syncMs`), and collider-line synchronization (`colliderMs`). `tileStats` records cache and renderer copy bytes, tile object creation/disposal over the sample interval, and the whole scene's draw calls and triangles. `drawMs` times the CPU call to `renderer.render` for the whole scene; it is **not** a GPU timer. The selected `tiles` count includes tiles outside the camera frustum, so it is not the number of terrain draw calls.

## Checks

`flight-check.ts` tests the wiring, not the features:

- Body-fixed axes turn into render axes exactly as three.js would.
- The rocket's drawn attitude is its attitude in space: exactly upright at the pad, and still correct after settling tilted on a slope (to float32, Rapier's precision).
- Co-rotating the camera about the spin axis keeps it fixed to the tilted planet's ground (6 hours, drift 4e-15).
- The map path's inertial trajectory is the same coast as the landing lab's body-fixed forecast (to 5e-10 m) and ends at the impact.

## Not here yet

- **Time warp.** The rate goes up to 200× (for watching day and night, most of all on `aurelia-fast`), but with no on-rails mode and no limit by altitude:
  - In orbital flight the propagation is cheap, under 1 ms a frame at 200×.
  - In contact (on or near the ground), Rapier steps at 1/60 s cost about 0.5 ms each. That is 48 ms a frame at 100× and 94 ms at 200×.
  - A frame advances at most 50 ms of wall time. So near the ground the simulated rate falls far below the chosen one, around 30× at 200×.
  - Tile builds do not keep up at high rates (see lab/view: about 10 new tiles per simulated second at 100 km), so the ground stays coarse until they catch up.
  - A real warp needs on-rails parts near the ground and a warp limit by altitude.
- **Map interaction:** manoeuvre nodes and the flight plan (lab/orbit has them).
- Atmosphere, terrain on other bodies, docking.
