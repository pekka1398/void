# Flight Lab

This is the first integration lab. It connects features that were each built and checked in their own lab:

- **lab/landing**: the two-stage rocket, with Rapier contact physics near the ground and orbit propagation in flight, plus staging, the terrain streamed by lab/lod, and the rocket visuals.
- **lab/orbit**: the N-body ephemeris of the whole solar system, reference frames and apsides.
- **lab/navball**: the attitude ball.
- **lab/view**: the single view. Zooming out from the rocket turns into the map, and the camera turns from the local vertical to the planet's north (see lab/view's decision).
- **lab/scenery**: layered terrain shared by visual and collision tiles, ground/ocean shading, atmosphere and volumetric clouds, star field and full-resolution transport pipeline.

The integration code was promoted to the repository's root `src/` on 2026-09-27 and is now the main game. This lab's `src/main.ts` imports that same entry point; there is no second implementation. The root `src/orbitCore.ts`, `src/landingCore.ts`, `src/navballCore.ts`, `src/viewCore.ts` and `src/sceneryCore.ts` import the feature labs directly. A change a feature needs is made in its own lab, and that lab's checks must keep passing. Integration wiring and game flow are changed in the root `src/`. `flight-check.ts` checks that root implementation, and the game and this lab share the root Vite configuration.

```sh
cd lab/flight
npm install
npm run dev        # http://127.0.0.1:5176/  (?planet=aurelia by default)
npm run check      # headless checks of the wiring
npm run typecheck
```

## The page

- **Planet.** The default is Aurelia inside the full sol system: the Sun, the planets and Selene, with a 23.4° axial tilt, all integrated as one N-body ephemeris. Aurelia, Terra and Aurelia-fast use scenery's layered terrain, streamed as lab/lod tiles through landing's worker. Sea level is 5 km above the reference sphere (the terrain's ocean-floor datum), and the rocket starts on dry lowland at 0.3 rad latitude and 0.5 rad longitude. `?terrain=hills` preserves the old ground and launch point, with the ocean off by default. `?planet=` also accepts the landing lab's lone planets (pebble, luna, terra), and `aurelia-fast`, which is Aurelia with a 2.4 h day for seeing the rotation in flight. Pebble and Luna stay airless.
- **Rendering.** Everything is in the inertial ecliptic frame, relative to the upper stage, with float64 subtraction on the CPU and a logarithmic depth buffer.
  - Tiles and rocket attitudes are body-fixed. They are turned into the scene by the planet's current orientation (`FlightFrame.bodyFixedToRender`).
  - The Sun lights the scene from its real direction, and a little ambient light keeps the night side flyable.
  - Scenery's shaders receive body-fixed camera and Sun vectors plus the inverse render rotation. Terrain shading transforms positions and normals into those same axes, while ocean displacement uses the terrain batch's own origin. Stars remain inertial as the planet spins. The solar-system Sun is the map's actual positioned mesh; lone-body lab fixtures use a fixed inertial light and scenery's sky disc.
  - The scene, joint air/cloud transport and resolve use matching full-resolution targets. ACES tone mapping and exposure match scenery's initial settings. Drawing resolution is capped at 1920×1080 and DPR at 1; LOD uses that actual pixel height. Simulation and drawing retain flight's animation loop, and hidden tabs skip updates/rendering.
- **Terrain observers.** lab/lod's observers are every live part, plus the camera (lab/lod's `LodCamera`). The camera splits tiles with the same table, stopping one level above the collision level, and is the only horizon for culling, so from far out the planet's face toward the camera is drawn. The rocket's own detail stops where its cells would be under 2 px on screen (lab/lod's pixel limit): with the camera near the rocket, drawn terrain equals collision terrain, and zoomed out the drawn ground coarsens while collision terrain, built separately, does not.
- **Camera.** This is lab/view's `OrbitCamera` and `viewState`, in single mode:
  - On the pad, the camera turns with the ground. In flight above about 25–76 km on Aurelia (0.004–0.012 R) it is inertial.
  - Zooming out from about 4 km (where the rocket is about 1 px) to 40 km fades in the map: orbits, labels, the rocket's forecast path and its Pe/Ap. The camera does not turn meanwhile, nor up to 400 km.
  - Then, from 400 km to 4,000 km, up turns from the local vertical to north, and the camera stops turning with the ground.
  - `Tab` or clicking a label focuses a body.
- **Map path.** It is the landing lab's coast forecast (`predictCoast`), recomputed every 2 s of simulated time. It is drawn from its inertial trajectory relative to the dominant body, and ends at the terrain.
- **Rocket.** It is sized KSP-style to reach low orbit on Aurelia without atmospheric forces (the new air is visual only): 8.6 km/s of Δv in all.
  - Booster: 120 kN, Isp 310 s, liftoff thrust-to-weight about 2, 3.4 km/s, 101 s burn.
  - Upper stage: 20 kN, Isp 340 s, thrust-to-weight about 1.5, 5.1 km/s, 183 s burn.
  - It takes a gravity turn: climb, then pitch toward the east, which is where the ground's 450 m/s helps.
- **HUD** is laid out after KSP, in this lab's plain style:
  - Top left: mission time and time rate (click, or `,`/`.`; see Time warp). Rates above the current limit are dimmed; asking for one, or losing it, says why.
  - Bottom left: the stages, with each part's own fuel and its vacuum Δv (the booster's counts the upper stage it pushes); the next stage is yellow, the burning one green.
  - Bottom centre: throttle, then altitude above speed in one box.
    - Click the altitude's label to switch AGL (above the ground under the rocket) and ALT (above the reference radius).
    - Click the speed's label to switch SURFACE (over the home planet's ground) and ORBIT (about the dominant body).
  - Beside the speed: lab/navball's ball, with the heading and pitch of the nose. It is drawn in the ecliptic frame, around the dominant body's local vertical and north, with grid north along its prime meridian exactly at a pole. Its prograde and retrograde markers follow the SURFACE/ORBIT switch.
  - Right: Ap, Pe and the impact, fading in with the map.
  - Top right: the dev panel (`` ` ``), collapsed at first: planet and terrain, visual atmosphere/cloud/ocean/star toggles, exposure, debug overlays, focus, camera and tiles.
  - Bottom right: the keys (`F1`).
- **Controls** are the landing lab's:
  - `Space` stages, `Shift`/`Ctrl` throttle, `X` cuts.
  - `WASDQE` steer, `P` pauses, `R` resets.
- **Log.** The dev server logs each session to `lab-log/flight.jsonl`: once per second the time rate, mode, altitude, camera distance, map weight, co-rotation, tiles, and frame, physics, LOD and draw times, plus focus changes and resets.

## LOD profiling

The **Draw terrain (profiling)** checkbox in the dev panel hides terrain draws while leaving LOD selection, tile workers, and tile object synchronization running. At a fixed camera and vessel position, wait until `queued` is zero, then compare several `flight-sample` records with the checkbox on and off. The `terrain-visibility` events mark each change.

`perf` separates LOD selection (`selectMs`, with `traverseMs`, `balanceMs`, and `evictMs`), worker queue maintenance (`queueMs`), tile geometry synchronization (`syncMs`), and collider-line synchronization (`colliderMs`). `tileStats` records cache and renderer copy bytes, tile object creation/disposal over the sample interval, and the scene pass's draw calls and triangles, captured before the transport/resolve passes reset renderer statistics. `drawMs` times the CPU call to the complete scenery pipeline; it is **not** a GPU timer. Samples include the scenery switches and drawing resolution. The selected `tiles` count includes tiles outside the camera frustum, so it is not the number of terrain draw calls.

## Checks

`flight-check.ts` tests the wiring, not the features:

- Body-fixed axes turn into render axes exactly as three.js would.
- The rocket's drawn attitude is its attitude in space: exactly upright at the pad, and still correct after settling tilted on a slope (to float32, Rapier's precision).
- Co-rotating the camera about the spin axis keeps it fixed to the tilted planet's ground (6 hours, drift 4e-15).
- The map path's inertial trajectory is the same coast as the landing lab's body-fixed forecast (to 5e-10 m) and ends at the impact.
- The default layered launch remains dry and both rocket parts survive settling.
- Scenery terrain satisfies landing's surface contract; cloned worker settings produce matching collision tile positions/heights and preserve geometry's cell-size filtering.
- The scenery ray and terrain uniforms agree across planet rotation and near-ground/orbital camera offsets.

## Time warp

One row of rates, after KSP's two warps but without showing two modes: 1×, 2×, 4×, 5×, 20×, 100×, 1k×, 10k×, 100k×.

- **1× to 4×: physics.** Everything is simulated, Rapier near the ground included, and the engine may burn and the rocket steer. Near the ground a Rapier step (1/60 s) costs about 0.5 ms, so 4× is about 2 ms a frame.
- **5× and up: on rails** (lab/landing's `advanceOnRails`). Flight parts coast on the orbit propagator, their attitude held and spin stopped. Parts asleep on the ground (Rapier's own rest test) stay where they are. Steering keys do nothing.
- **Limits.** Each frame the highest allowed rate is worked out, and a higher one drops to it at once:
  - An engine firing, or any part awake near the ground (settling, sliding, or just coming down into the contact band), holds the rate at 4×.
  - Dropping from an on-rails rate to a lower on-rails rate steps down to it. Dropping out of on-rails goes straight to 1×, so there is time to react.
  - The lowest part in orbital flight caps the on-rails rate by its clearance: 5× from 0.001 R, 20× from 0.0015 R, 100× from 0.002 R, 1k× from 0.01 R, 10k× from 0.05 R, 100k× from 0.2 R. On Aurelia that is 6.4 km, 9.6 km, 12.7 km, 64 km, 319 km and 1,274 km. These are first guesses: the ground under the rocket, tile builds and the catch at the band all have to keep up.
  - A rocket asleep on the ground has no altitude limit: on the pad, 100k× runs a day in under a second.
- A coast coming down stops on rails where it enters the contact band. Entering it (building the Rapier world and its terrain colliders) costs one frame of about 140 ms, as it does at physics rates.
- Tile builds do not keep up at high rates (see lab/view: about 10 new tiles per simulated second at 100 km), so the ground stays coarse until they catch up.

## Not here yet

- **Map interaction:** manoeuvre nodes and the flight plan (lab/orbit has them).
- Atmospheric forces, sea buoyancy, terrain on other bodies, docking. Clouds remain static and do not cast ground shadows. Sea rendering raises submerged vertices to sea level; collision terrain remains the solid seabed.
