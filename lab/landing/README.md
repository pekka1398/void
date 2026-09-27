# Landing Lab

Standalone experiment: landing on and taking off from a rotating planet with terrain. Both the single-body lander and the interactive two-part rocket use the orbit lab's inertial propagator above the terrain band, then hand position and velocity to Rapier in the planet-fixed frame for near-ground contacts. The two-part rocket keeps an impulse-jointed pair in Rapier near the ground; in free flight its attached stack follows one integrated centre-of-mass state, and after staging each part follows its own orbit state.

```sh
cd lab/landing
npm ci
npm run check      # headless checks
npm run typecheck
npm run build      # typecheck and bundle the page
npm run dev        # interactive page
```

## Contracts with the other labs

- **Terrain**: `SurfaceSampler` has the same signature as lab/lod's: a unit body-fixed direction goes in, and height above the reference radius plus a colour come out. Swapping in lab/lod's terrain means passing its function. `checkTerrainContract` checks any terrain for what the rest of this lab relies on: non-unit input throws, samples are deterministic, heights and colours stay in bounds, and a 1 cm step never changes the height by 1 m or more. It runs on this lab's terrain now, and should run on lab/lod's when that terrain is swapped in.
- **Tiles**: lab/lod's planet core is imported through `src/lodCore.ts` (like `orbitCore.ts`); changes it needs are made in lab/lod. Collision tiles and drawn tiles are both built by its `buildTileMesh`: Rapier gets the surface triangles, the renderer gets the whole tile. Collision uses one level (about 300 m tiles); drawing uses lab/lod's quadtree down to that level.
- **Physics**: free-flight states use the orbit lab's inertial propagator. The near-ground Rapier world uses `PlanetFrame`; entering and leaving its altitude band converts the full position and velocity state. The two-stage rocket uses mass-weighted centre-of-mass propagation while attached and independent propagators after staging, and recreates its Rapier bodies when it re-enters the contact band. After staging each part crosses the band on its own clearance: a spent booster falling into Rapier leaves the upper stage in orbital propagation. Contact parts within half the recentre distance share one Rapier world; parts farther apart than the recentre distance get separate worlds. A part whose speed change from Rapier contacts in one step exceeds its crash tolerance (`crashToleranceMetersPerSecond`, default 10 m/s) is destroyed and removed, as in KSP; losing the upper stage ends the flight. This is off by default (`crashDetection = false`), so impacts only collide and can bounce.
- **Encounter range hook**: `EncounterPhysicsGate` compares positions and velocities in one shared coordinate frame, predicting closest approach over the next propagation interval. It promotes a pair predicted to pass within 10 km and keeps it physical until it is beyond 15 km with no near pass predicted. A future docking implementation must put every active pair into a shared Rapier world before enabling mutual collision checks.
- **Axes**: body-fixed axes follow the orbit lab (z = spin axis, x = prime meridian). lab/lod's core has no axis convention of its own: it takes body-fixed directions and a sampler. Only its lab page's camera and probe treat y as up.

## Planets

- `pebble` (`src/planet/Planets.ts`): 100 km radius and a Moon-like 1.6 m/s² surface gravity, which makes it far denser than real rock. A 3.5 h spin moves the equator at 50 m/s, so rotating-frame effects are large enough to test. Placeholder hills reach up to 3 km.
- The checks also run at Earth size (6371 km), so precision problems show up early.
- `aurelia`: the orbit lab's Earth analogue inside its full sol system, with the Sun, the planets and Selene, a 23.4° axial tilt, and terra's placeholder hills. It is the first planet that is not alone: the rocket stands on body `bodyIndex` of a many-body ephemeris, and the rotating frame carries the Sun's and Selene's tides. `planetEphemeris(planet)` builds any planet's ephemeris and returns its index. A lone planet steps one minute; a system uses the orbit lab's suggested step. The per-planet launch-and-return and drawn-equals-collision checks cover it like the others.
- `aurelia-fast`: Aurelia spinning ten times faster, a 2.4 h day, to make the rotating frame plain to see. At the launch site the ground moves 4.5 km/s and the centrifugal pull is about a third of gravity. Everything else, including J2, is the sol preset's.

## Shared with the main game and lab/flight

The main game in the repository's root `src/` imports these instead of copying them. lab/flight runs the same game entry point:

- `vessel/DemoRocket.ts`: the two-stage rocket's collider shapes, masses and contact options, sized to the planet.
- `render/RocketVisual.ts`: its meshes, engine plumes and collider outlines.
- `vessel/CoastPrediction.ts`: `predictCoast`, whose result also carries the coast as a barycentric inertial `Trajectory`, for map paths and apsides. That trajectory ends at most one sample past the terrain crossing.
- `PartJointRocket.landed(rapier, ephemeris, bodyIndex, ...)` now takes the planet's index in the ephemeris instead of assuming body 0.

## Terrain tiles (`src/terrain/TerrainTiles.ts`, `TerrainView.ts`)

- A tile is lab/lod's `resolution`² grid (33 × 33 here) with two triangles per cell, wound outward. Collision builds one only near what can touch the ground.
- Vertices are float32 offsets from a float64 origin on the terrain at the tile centre. On an Earth-size planet, vertices are within 6 µm of the terrain.
- Neighbouring tiles, including three faces meeting at a cube corner, share every edge vertex to within float32 rounding (under 20 µm).
- `tilesAround(point, reach)` (lab/lod's `TileSearch.ts`) returns every tile touching the surface within the reach.
- **Drawing**: `TerrainView` runs lab/lod's `PlanetLod` with every live rocket part as an observer, builds tiles in workers, and draws them with its `TileRenderer`. Workers rebuild the terrain from `TerrainConfig`, so their tiles are bit-identical to the main thread's. `landingLodOptions` sets the finest level to the collision level and splits early enough that every collision tile within `tileKeepMeters` of a part is drawn at that level with same-level neighbours, so the renderer never stitches its edges: the drawn triangles there are the collision triangles. The check tests this on the ground, at the top of collision range, at a cube corner, and for two parts 20 km apart.
- The page uses Three.js's WebGPU renderer on its WebGL2 backend, as lab/lod does; one copy of `three` serves both (`vite.config.ts` dedupes it).

## Contacts in the rotating frame (`src/physics/`)

- `PlanetFrame`: the planet's body-fixed frame, with its origin at the centre, z along the spin axis and x at the prime meridian. It converts states to and from the orbit lab's barycentric inertial frame: r = Rᵀ(p − c) and v = Rᵀ(u − c′) − ω×r. It also gives the acceleration of a free particle in this frame:
  - the planet's gravity, including J2;
  - the tidal part of other bodies' gravity, since the frame's origin falls freely with the planet;
  - centrifugal −ω×(ω×r) and Coriolis −2ω×v. With a constant spin there is no Euler term.
- `ContactWorld`: Rapier rigid bodies in that frame.
  - **Floating origin:** Rapier's float32 coordinates are offsets from a float64 origin, which follows the bodies.
  - **Tile streaming:** collision tiles load around bodies near the ground, with hysteresis.
  - **Forces:** Rapier's gravity is off. Each step kicks velocities by `PlanetFrame.acceleration`, then Rapier resolves contacts and moves bodies.
  - **Accuracy:** the velocity Rapier holds is treated as the half-step velocity (bodies enter with v − a dt/2 and are read as u + a dt/2), which makes Rapier's first-order kick-drift the second-order leapfrog.

Measured by `npm run check`:

- The rotating-frame equations, integrated with fine RK4 on a 150 s hop, match the orbit lab's inertial integration of the same hop to 5e-8 m. The test planet has an exaggerated J2 of 0.01 and a moon, so every term is exercised.
- Rapier free flight at 60 Hz stays within 7 mm and 1e-4 m/s of the same reference over 150 s. Plain kick-drift would be about 2 m off.
- A box set down on the equator, which moves at 50 m/s, stays where it came to rest. It is at rest in the rotating frame, so Rapier puts it to sleep.
- A ball launched at 30 m/s rolls and bounces 2.3 km across 67 streamed tiles without sinking into the ground.
- Moving the floating origin 800 m changes a state by 2e-5 m (float32 rounding).

Not modelled: the frame's fictitious torques on spinning bodies (of order ω, 6e-4 rad/s here).

## Status

| Phase | Scope | State |
|---|---|---|
| P1 | Lab setup, terrain contract, collision tiles (now lab/lod's tile builder) | done |
| P2 | Rapier contacts in the rotating frame; drift and rest checks | done |
| P3 | Hand-off between inertial free flight and live ground contacts | done |
| P4 | Page: rendering, controls, camera frames, terrain-aware prediction | done |

## Flight and landing (`src/vessel/Lander.ts`)

- A lander has two modes: inertial free flight with the orbit lab's propagator and rotating-frame Rapier contacts near the terrain. Contact stays live after touchdown, so the craft can tip, bounce or slide. The contact band has separate entry and exit heights to avoid repeated switching.
- Thrust uses the same surface-relative direction law in both physics engines. Contact integration accounts for fuel lost during each step and carries the half-step thrust across mode changes.
- The P3 check launches from a slope, crosses from contact to free flight and back, then reaches the ground. While clear of terrain, its trajectory is compared with an independent run of the orbit lab's integrator. A separate controlled landing reaches about 13.6 km and touches down below 1 m/s. Once on the ground it remains a Rapier rigid body.
- **On rails** (`PartJointRocket.advanceOnRails`, for high time warp):
  - Flight parts coast on the propagator with attitudes held and spin stopped.
  - Contact worlds whose bodies Rapier has put to sleep only move their clock (`ContactWorld.idleTo`). A resting part stays fixed in the body-fixed frame and turns with the planet.
  - `railsBlocker(throttle)` says why it is not allowed: an engine firing, or a part awake near the ground. It returns false where a coasting part comes down into the contact band, and the caller goes back to physics time.
  - The check puts a resting rocket on rails for a day (it moves 0 m) and compares 200 s of coasting on rails with physics time (6e-5 m apart). It also checks that a coast coming down stops at the band.

## Interactive page

The page's two-stage rocket has an upper stage and booster, each with its own fuel, render mesh, and compound collider. Near the ground they are Rapier rigid bodies connected by a fixed impulse joint. In free flight the attached stack follows one orbit-integrated centre-of-mass state; after staging, each part has its own orbit state and switches physics mode independently. Crossing the terrain band rebuilds the Rapier contact bodies from those states, so render meshes persist but Rapier body identities do not persist across physics-mode changes. The first Space press ignites the booster; the second removes the joint and applies equal and opposite separation impulses. Green outlines come from the collider shapes used by Rapier (cylinder, cone, struts, and foot pads), not a stand-in box. Contacts between the two parts stay enabled. Rapier's fixed joint is not rigid: with the seam contact disabled, the joint alone carried the booster's thrust and the stack bent and tipped over during a burn (the per-planet launch check caught it). The seam contact costs some steering response: one second of full pitch turns the page's rocket 32° rather than 40°, and the check's box-shaped stages, whose faces touch, far less.

Attitude is simulated in both modes. Near the ground Rapier integrates it. In free flight `vessel/Attitude.ts` repeats Rapier's angular step with each part's collider inertia (the attached stack adds the parallel-axis terms): steering torque, the gyroscopic term, rotation, then the same angular damping (0.8). Rotation and angular velocity are carried across every hand-off. It matches Rapier exactly at moderate spin; Rapier's implicit gyroscopic treatment drifts from it by a fraction of a degree only at several rad/s off-axis. While thrusting and turning, orbital propagation advances one physics step at a time so thrust follows the attitude.

Both stages have visible engine bells. The active engine shows a throttle-driven exhaust plume and glow; the bell sits within the stage collider, while the exhaust is a visual effect without collision.

Open the Vite page, press **Space** to ignite the booster, then raise the throttle. Press **Space** again to separate the booster and activate the upper engine. **Throttle 0** starts a coast without undoing the stage. The camera can follow either the rotating surface or inertial axes. The active connected group's centre of mass, then the upper part after separation, stays at the render origin for precision. The whole planet is drawn through lab/lod's quadtree, finest around each rocket part. "Show collision meshes" shows the drawn tiles' triangle edges; near the parts these are the collision triangles.

Keyboard controls follow the KSP decompile's `GameSettings.cs` and `FlightInputHandler.cs`: **Space** advances staging, **Shift/Ctrl** raise/lower throttle (about 50 percentage points per second), **W/S** pitch down/up, **A/D** yaw left/right, and **Q/E** roll left/right. The engine starts with 0% throttle. Steering applies torque to the active upper part; the fixed joint carries it to the booster while attached. Thrust follows the engine part's actual rotation. There is no SAS.

**Show collision meshes** overlays the unique triangle edges of loaded terrain colliders and the actual compound colliders of both parts in white.

The cyan line is an engine-off forecast from the current state using the orbit lab's propagator, sampled against the terrain height function; its endpoint is the first terrain crossing. The forecast stops after 600 seconds if no crossing occurs. It is not a powered-flight plan, and it does not simulate the final Rapier bounce or rest. The coast-impact check drops a craft from 100 m and finds the terrain to within 0.01 m.

## Not implemented yet

- **Docking and multi-vessel physics:** `EncounterPhysicsGate` is a tested range and closest-approach policy only. Landing has no second-vessel registry, no shared Rapier world for two ships, no mutual vessel collision, and no docking-port capture or joint.
- **Encounter prediction validation:** the gate uses constant relative velocity over the caller-provided next interval. Callers must check before advancing that interval; it is not yet connected to an encounter simulation loop and does not account for curvature during long look-aheads.
- **Structural flex:** the attached stack is one rigid body in free flight and a stiff fixed joint near the ground; there is no bending or joint compliance model, and part offsets ignore each collider set's own centre of mass.
- **Atmosphere and detailed landing systems:** there is no aerodynamic drag, heating, parachute model, suspension, or landing-leg deployment. The terrain is procedural placeholder relief; collision uses one tile level (drawing uses LOD).
- **Landing guidance:** the cyan prediction is coast only. There is no powered landing planner/autopilot, SAS, or target-relative rendezvous guidance.
