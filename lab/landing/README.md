# Landing Lab

Standalone experiment: landing on and taking off from a rotating planet with terrain. Free flight uses the orbit lab's physics core (`../orbit/src/orbit`), imported rather than copied, so a trajectory here is the same code as there. Contacts with the ground use Rapier in the planet's rotating frame.

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
| P1 | Lab setup, terrain contract, collision tiles | done |
| P2 | Rapier contacts in the rotating frame; drift and rest checks | done |
| P3 | Hand-off between inertial free flight and live ground contacts | done |
| P4 | Page: rendering, controls, camera frames, terrain-aware prediction | done |

## Flight and landing (`src/vessel/Lander.ts`)

- A lander has two modes: inertial free flight with the orbit lab's propagator and rotating-frame Rapier contacts near the terrain. Contact stays live after touchdown, so the craft can tip, bounce or slide. The contact band has separate entry and exit heights to avoid repeated switching.
- Thrust uses the same surface-relative direction law in both physics engines. Contact integration accounts for fuel lost during each step and carries the half-step thrust across mode changes.
- The P3 check launches from a slope, crosses from contact to free flight and back, then reaches the ground. While clear of terrain, its trajectory is compared with an independent run of the orbit lab's integrator. A separate controlled landing reaches about 13.6 km and touches down below 1 m/s. Once on the ground it remains a Rapier rigid body; high time warp is unavailable during contact.

## Interactive page

Open the Vite page, press **Space** to stage the engine, then raise the throttle. **Throttle 0** starts a coast without undoing the stage. The camera can follow either the rotating surface or inertial axes. The craft stays at the render origin for precision, while the terrain and planet move around it. Nearby visual tiles use the same mesh builder as contact tiles. A coarse planet mesh fills the distance behind them.

Keyboard controls follow the KSP decompile's `GameSettings.cs` and `FlightInputHandler.cs`: **Space** stages the engine once, **Shift/Ctrl** raise/lower throttle (about 50 percentage points per second), **W/S** pitch down/up, **A/D** yaw left/right, and **Q/E** roll left/right. The engine starts with 0% throttle and remains staged when throttle returns to zero. In contact, steering applies torque to the Rapier body and the rendered craft follows its actual rotation. In free flight, angular velocity accumulates under steering input and decays; the thrust axis follows the craft. This lab still has one engine and no multi-stage stack or SAS.

**Show collision meshes** overlays the unique triangle edges of loaded terrain colliders and the craft's Rapier box in white. The box reaches the bottoms of the visible landing legs, so those legs no longer extend below the contact shape.

The cyan line is an engine-off forecast from the current state using the orbit lab's propagator, sampled against the terrain height function; its endpoint is the first terrain crossing. The forecast stops after 600 seconds if no crossing occurs. It is not a powered-flight plan, and it does not simulate the final Rapier bounce or rest. The coast-impact check drops a craft from 100 m and finds the terrain to within 0.01 m.
