# Orbit Lab

Standalone experiment for Principia-style orbital mechanics: every massive body is integrated as one N-body problem, and the vessel moves only under gravity from all of them (plus its own thrust). The lab does not use the game or `lab/lod`. Planets will be drawn as plain spheres.

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
  - body centred inertial: equatorial axes (the body's ECI), with z along the spin axis and x at the equinox, where the equator crosses the ecliptic
  - body surface (rotating with the body, including its axial tilt)
  - two-body rotating: origin at the pair's barycenter, x from primary to secondary, z along their relative angular momentum.
- **Focus**: the object the camera orbits. Clicking a label or pressing `Tab` also changes it.
- **Body trails / Vessel history**: past paths in the selected frame. A body's trail is at most one of its own orbital periods. Past samples are cached in frame coordinates because a frame's transform depends only on the sample time, so only new samples cost anything.
- **Readout**: osculating two-body values relative to the body whose Laplace sphere of influence contains the vessel. This choice only affects display; the dynamics are always full N-body.
- `Space` pauses, and `,` `.` change warp from 1× to 1e7×. Each frame spends at most 20,000 vessel steps. When warp asks for more, simulated time advances only as far as those steps reach and the status shows `LAGGING` with the warp actually achieved. Time is never skipped.
- Labels that would overlap a higher-priority label (focus, then vessel, then bodies by mass) keep only their dot.

### Vessel (P3)

The default stage is chemical: 250 kN of thrust, Isp 350 s, 10 t dry mass and 30 t of propellant, which gives 4.76 km/s of delta-v. It starts in a 400 km circular orbit. **Start orbit** chooses its plane: the home body's equator, or the current orbital plane of one of its moons (the default is Selene, or Lumen in the binary preset). Selene's orbit is 18–28° from Aurelia's equator, so from an equatorial orbit a transfer only works when Selene crosses the equator, twice a month. From its plane, a prograde burn of about 3.1 km/s reaches it within the first orbit. Changing the choice resets the vessel.

- `Shift`/`Ctrl` raise and lower the throttle, `Z` sets full and `X` cuts. Thrust is integrated as a finite burn. Mass falls at thrust / (Isp g0). When the tanks empty inside a frame, that leg ends exactly at burnout and the rest of the frame coasts.
- Attitude keys `1`–`7` select prograde, retrograde, normal, antinormal, radial out, radial in and hold. The first six track the trajectory's Frenet frame relative to the **reference** body, recomputed continuously during the burn. `Hold` freezes the current direction in inertial space. The orange line shows where the engine points.
- **Reference**: `Auto` uses the body whose sphere of influence contains the vessel. A fixed choice also drives the readout and the apsides.
- **Prediction** (cyan): the coast trajectory from the current state with the engine off, extended by up to 4,000 steps per frame toward the chosen horizon. It restarts whenever the engine fires. Apsides are the actual extrema of distance to the reference body along that N-body trajectory, found where the radial velocity changes sign, rather than osculating values. They are marked on the path along with any predicted impact.

### Flight plan (P4)

A list of burns, each a Δv along prograde, normal and radial relative to a chosen **reference** body, and a start time. Every burn runs at full thrust; its duration comes from the rocket equation and the mass left by the burns before it. During the burn the direction follows the Frenet frame relative to the reference body, so the Δv delivered equals the one planned.

- `+ Burn` adds a burn 10 minutes after now or after the last valid burn. Select a burn in the list to edit it: the time buttons shift its start, `@ next Pe` / `@ next Ap` centre it on the next apsis of the N-body coast before it, and the Δv fields accept typing, `−`/`+` or the mouse wheel in the chosen step.
- Burns are checked in order. A burn that starts in the past, overlaps the previous one or needs more propellant than is left is marked ✕ with the reason, and every burn after it is blocked. Only the valid prefix is flown or drawn.
- **Plan** (amber, burns orange): the trajectory through all valid burns, then a coast set by **Coast after last burn** (default 7 d, enough to reach Selene). It is integrated from the vessel's state at the time of the last edit, up to 4,000 steps per frame. Apsides after the last burn are marked, along with any impact. When the frame is centred on a body, both the plan's and the prediction's apsides are measured from that body, as in Principia: plan in Aurelia's frame, switch the frame to Selene, and tune the Selene periapsis.
- Execution is automatic. At a burn's start time the engine runs at full thrust along the planned direction and the manual throttle is ignored. When the burn ends it leaves the list, and the rest of the plan continues from the new state. Manual thrust between burns re-plans from the new state, and burn durations follow the new mass.
- `Warp to burn` runs at maximum warp to 30 s before the next valid burn, then drops to 1×. `Space`, `,` and `.` cancel it.

## Status

| Phase | Scope | State |
|---|---|---|
| P1 | Ephemeris, vessel integrator, headless checks | done |
| P2 | Viewer: system, trajectories, time warp, reference frames | done |
| P3 | Vessel control, finite burns, prediction | done |
| P4 | Flight plan: burns, plan trajectory, execution | done |

## Core (`src/orbit/`)

All values are SI. The frame is ecliptic and right-handed, with +Z at ecliptic north, and its origin is the system barycenter.

- `SystemSpec.ts` builds initial state vectors from a body tree. Each child's elements are **Jacobi** elements: its subtree barycenter orbits the barycenter of its parent plus all earlier siblings. Planets listed after a companion star therefore orbit the binary's barycenter. The whole system is shifted to zero barycenter and zero momentum.
- `Ephemeris.ts` integrates the massive bodies with Yoshida's 8th-order symplectic composition, using a fixed step and Kahan-compensated positions. Every step stores position, velocity and acceleration, and any covered time is queried by quintic Hermite interpolation. Queries outside the integrated or retained interval throw. `forgetBefore` releases old chunks.
- `VesselPropagator.ts` integrates a massless vessel with adaptive Dormand–Prince 5(4) under absolute per-step position and velocity tolerances. Runs can be resumed with a step budget, and a budgeted run reproduces an uninterrupted one bit for bit. Surface impacts are screened along each step and then bisected with real integrated states to 0.1 ms.
- `FlightPlan.ts` turns planned burns into full-thrust schedules and checks them. It integrates the planned trajectory with the same propagator, and places a burn centred on an apsis. `Simulation.ts` flies the schedule, splitting integration legs exactly at burn start and end.
- `Kepler.ts` provides strict element/state conversion and osculating quantities. Hyperbolic and radial orbits report infinite apoapsis or period rather than invented values.

Defaults chosen from measurements in `orbit-check.ts`:

- Ephemeris step: 256 steps per tightest Jacobi periapsis passage. This gives 594 s for the Sol system, which is set by Ember's 1.77-day orbit. The integration difference against a half-size step over 60 days is 6 cm. Interpolation adds less than 0.1 mm. Energy drift over 10 years is about 1e-12, and 10 years takes about 2 s.
- Vessel tolerances: 1e-4 m and 1e-7 m/s per step. This is about 250 steps per orbit, with 0.8 m error over 20 eccentric orbits against analytic Kepler.

## Fixtures (`src/app/SystemPresets.ts`)

- `sol`: real Sun, Mercury, Earth, Moon, Mars, Jupiter and three Galilean moons, under fictional names.
- `binary`: a circumbinary system in the spirit of the game's Astris Prime, using real-scale bodies.
