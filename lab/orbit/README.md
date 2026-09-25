# Orbit Lab

Standalone experiment for Principia-style orbital mechanics: every massive body is integrated as one N-body problem, and the vessel moves only under gravity from all of them (plus thrust in a later phase). The lab does not use the game or `lab/lod`. Planets will be drawn as plain spheres.

```sh
cd lab/orbit
npm ci
npm run check      # headless invariant checks
npm run typecheck
```

## Status

| Phase | Scope | State |
|---|---|---|
| P1 | Ephemeris, vessel integrator, headless checks | done |
| P2 | Viewer: system, trajectories, time warp, reference frames | next |
| P3 | Vessel control, finite burns, prediction | |
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
