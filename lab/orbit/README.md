# Orbit Lab

Standalone experiment for Principia-style orbital mechanics: every massive body is integrated as one N-body problem, and the vessel moves only under gravity from all of them (plus thrust in a later phase). The lab does not use the game or `lab/lod`. Planets will be drawn as plain spheres.

```sh
cd lab/orbit
npm ci
npm run dev        # lab page (Vite prints the URL)
npm run check      # headless invariant checks
npm run typecheck
```

## Page

The page uses a plain three.js `WebGLRenderer` with a logarithmic depth buffer. Bodies are solid-colour spheres drawn to true scale, with an equator and a prime meridian so rotation is visible. Stars are unlit and carry a point light with no distance decay. Rendering uses kilometres relative to the focused object (floating origin), so float32 precision is spent near the focus.

- **System**: the fixture to load. Changing it reloads the page with `?system=sol|binary`.
- **Frame**: the frame everything is plotted in:
  - barycentric inertial
  - body centred inertial
  - body surface (rotating with the body, including its axial tilt)
  - two-body rotating: origin at the pair's barycenter, x from primary to secondary, z along their relative angular momentum.
- **Focus**: the object the camera orbits. Clicking a label or pressing `Tab` also changes it.
- **Body trails / Vessel history**: past paths in the selected frame. A body's trail is at most one of its own orbital periods. Past samples are cached in frame coordinates because a frame's transform depends only on the sample time, so only new samples cost anything.
- **Readout**: osculating two-body values relative to the body whose Laplace sphere of influence contains the vessel. This choice only affects display; the dynamics are always full N-body.
- `Space` pauses, and `,` `.` change warp from 1× to 1e7×. Each frame spends at most 20,000 vessel steps. When warp asks for more, simulated time advances only as far as those steps reach and the status shows `LAGGING` with the warp actually achieved. Time is never skipped.
- Labels that would overlap a higher-priority label (focus, then vessel, then bodies by mass) keep only their dot.

## Status

| Phase | Scope | State |
|---|---|---|
| P1 | Ephemeris, vessel integrator, headless checks | done |
| P2 | Viewer: system, trajectories, time warp, reference frames | done |
| P3 | Vessel control, finite burns, prediction | next |
| P4 | Flight plan (maneuver nodes) | |

## Core (`src/orbit/`)

All values are SI. The frame is ecliptic and right-handed, with +Z at ecliptic north, and its origin is the system barycenter.

- `SystemSpec.ts` builds initial state vectors from a body tree. Each child's elements are **Jacobi** elements: its subtree barycenter orbits the barycenter of its parent plus all earlier siblings. Planets listed after a companion star therefore orbit the binary's barycenter. The whole system is shifted to zero barycenter and zero momentum.
- `Ephemeris.ts` integrates the massive bodies with Yoshida's 8th-order symplectic composition, using a fixed step and Kahan-compensated positions. Every step stores position, velocity and acceleration, and any covered time is queried by quintic Hermite interpolation. Queries outside the integrated or retained interval throw. `forgetBefore` releases old chunks.
- `VesselPropagator.ts` integrates a massless vessel with adaptive Dormand–Prince 5(4) under absolute per-step position and velocity tolerances. Runs can be resumed with a step budget, and a budgeted run reproduces an uninterrupted one bit for bit. Surface impacts are screened along each step and then bisected with real integrated states to 0.1 ms.
- `Kepler.ts` provides strict element/state conversion and osculating quantities. Hyperbolic and radial orbits report infinite apoapsis or period rather than invented values.

Defaults chosen from measurements in `orbit-check.ts`:

- Ephemeris step: 256 steps per tightest Jacobi periapsis passage. This gives 594 s for the Sol system, which is set by Ember's 1.77-day orbit. The integration difference against a half-size step over 60 days is 6 cm. Interpolation adds less than 0.1 mm. Energy drift over 10 years is about 1e-12, and 10 years takes about 2 s.
- Vessel tolerances: 1e-4 m and 1e-7 m/s per step. This is about 250 steps per orbit, with 0.8 m error over 20 eccentric orbits against analytic Kepler.

## Fixtures (`src/app/SystemPresets.ts`)

- `sol`: real Sun, Mercury, Earth, Moon, Mars, Jupiter and three Galilean moons, under fictional names.
- `binary`: a circumbinary system in the spirit of the game's Astris Prime, using real-scale bodies.
