# View Lab

Standalone experiment for the trade-off between one view and two views:

- **One view**: zooming out from the vessel fades the map in.
- **Two views** (KSP): `M` switches between the flight view and the map.

The page imports three things instead of copying them:

- the orbit lab's physics core: ephemeris, vessel integrator, prediction and apsides;
- the landing lab's terrain and tile streaming, which is lab/lod's quadtree, renderer and workers;
- the orbit lab's `PathCache` and system presets.

There is no Rapier and no rocket here. The vessel is the orbit lab's point mass, with throttle and attitude modes so its orbit can be changed.

```sh
cd lab/view
npm install
npm run dev        # http://127.0.0.1:5175/?view=single  or  ?view=split
npm run check      # headless checks of the camera, orbit loops and LOD observers
npm run typecheck
```

- `?view=single|split` chooses the trade-off under test. The panel's View select reloads with the other one.
- `?altitude=<km>` sets the vessel's circular equatorial start orbit around Aurelia. The default is 100 km.

## Decision (2026-09-25)

**Single view.** Zooming out from the vessel turns into the map without a switch. The map fades in first; then, zooming further, the camera's up vector swings from the local vertical to the planet's north. That turn is part of the effect, not a side effect to hide, but it is kept apart from the fade so only one thing changes at a time. The split mode stays here only for comparison. Development continues with the single view, and it is the one merged into the landing lab.

## What KSP does

From `lab/ksp-decompile`:

- **Two worlds.**
  - The flight world is at true scale: PQS terrain and the vessel, drawn by `FlightCamera`.
  - The scaled world (`ScaledSpace.scaleFactor = 6000`) holds low-poly planets, drawn by `ScaledCamera` as a backdrop. It follows the flight camera's rotation.
  - The split exists because Unity only has float32.
- **Entering the map** (`MapView.enterMapView`):
  - disables the flight camera and enables `PlanetariumCamera`, which lives in the scaled world;
  - turns on the orbit renderers;
  - locks flight input (`ControlTypes.MAPVIEW`);
  - carries the zoom across as `camDistance * ScaleFactor`.
- **Zoom ranges.** Both cameras have `minDistance 3` and `maxDistance 150000`, but in their own units. That means 3 m to 150 km in flight, and 18 km upward on the map.
- **Terrain.** PQS terrain is not rebuilt on the switch: `PQSMod_CelestialBodyTransform` returns early while the map is on.

## What this lab does instead

Everything is in one float64 world, drawn relative to the focus with a logarithmic depth buffer. The camera can therefore go from 8 m off the vessel to 2e13 m without a second scene.

- **Frames.** Bodies are drawn in the ecliptic frame. The home planet's tiles are drawn in its body-fixed frame, turned by its current orientation.
- **Orbit lines.**
  - The vessel's path is its N-body prediction, drawn relative to its reference body, in that body's non-rotating frame.
  - Bodies' orbits are osculating ellipses about their parents (`ConicPath.ts`).
- **Terrain observers.** lab/lod's observers are the vessel (the probe) and the camera:
  - A tile splits for its nearest observer, so the camera adds detail only where it is closer to the ground than the vessel.
  - A tile is culled only if it is below both observers' horizons, so a camera far out sees the planet's face toward it.
- **Camera** (`ViewCamera.ts`): one direction (focus to camera) in the inertial frame, and a distance. Each frame, `viewState` decides:
  - **Map weight** (0 = flight, 1 = map).
    - Single mode: a log-distance smoothstep between 0.00063 and 0.0063 radii of the reference body. On Aurelia that is about 4 km to 40 km from the vessel, or above a focused body's surface. It starts where lab/flight's 4 m rocket shrinks to about 1 px, so the path and the vessel's label take over from the rocket itself.
    - Split mode: exactly 0 or 1.
    - Orbit lines and labels are drawn at this opacity. Labels only take clicks above 0.5.
  - **Up weight** (0 = local vertical, 1 = the body's north).
    - Single mode: its own log-distance smoothstep, between 0.063 and 0.63 radii (400 km to 4,000 km on Aurelia). It starts only well after the map is fully in (40 km on Aurelia), so zooming out shows the orbits first and turns the camera after; the two never happen at once.
    - Split mode: the same as the map weight.
    - The up is the local vertical turned toward north by this weight. The flight view keeps the horizon level, and the map has north up.
  - **Co-rotation**: the fraction of the reference body's spin the camera follows. It is `(1 - up weight) × (1 - smoothstep(altitude, 0.004 R, 0.012 R))`, so the camera lets go of the ground together with the up turn, not while the map fades in.
    - A landed or low vessel's view turns with the ground.
    - An orbiting vessel's close-up is inertial, like KSP's orbital camera.
    - The map is always inertial.
  - **Zoom range**:
    - single: 8 m (vessel) or 1.02 R (body) up to 2e13 m;
    - split flight: 8 m to 150 km, vessel only;
    - split map: at least 18 km, or 18 km above a body.
- **Split mode.**
  - `M` switches instantly and keeps the camera direction.
  - Tab focus works only on the map.
  - Leaving the map returns the focus to the vessel.
  - Dragging clamps the elevation 0.02 rad from straight up and down, so a long drag stops at the pole.

`ViewCamera.ts` (camera and view state) and `MapLayer.ts` (body spheres, orbit loops, the vessel's path with apsides, and labels) are modules of their own, and lab/flight imports both.

The dev server logs each session to `lab-log/view.jsonl`:

- once per second: map weight, up weight, co-rotation, distance, tiles drawn, and frame, LOD and draw times;
- on every focus change and map switch.

## Not here yet

- Map interaction: manoeuvre nodes and the flight plan. The orbit lab has them.
- Input modes: whether the mouse steers or picks orbits.
- Other bodies with terrain. Only the home planet is lab/lod tiles; the rest are spheres.
- Atmosphere.
- The rocket and Rapier.
