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

- `+ Burn` adds a burn 10 minutes after now or after the last valid burn. Select a burn in the list to edit it. Its start is an absolute mission time (T+, so it does not tick while you edit; the countdown is shown below it). `@ next Pe` / `@ next Ap` centre it on the next apsis of the N-body coast before it.
- Plan fields (start, coast, Δv) are digit fields. The wheel over a time unit steps it by one day, hour, minute or second; Δv is shown in km/s (`+3.120`): the wheel over the kilometres steps 1 km/s, and over the metres 1 m/s. Typed Δv is in m/s unless it ends in `km/s`, and keeps up to 0.01 m/s, shown in grey as further km/s decimals (`+3.120` `45` = 3.12045 km/s). No step size needs choosing. Clicking a field turns it into a text box: Enter commits and Escape cancels. Times accept `2d 03:04:05`, `3:04:05`, `4:05` or `2.5d` / `3h` / `10m` / `30s`, and text that does not parse keeps the old value. Coast is at least 1 minute, and times go up to 999 days.
- A burn's **Reference** defaults to `Auto`. It follows the body whose sphere of influence holds the planned trajectory at ignition, and it is re-resolved after every plan edit, in burn order. So a burn moved to a lunar flyby becomes relative to Selene, and its retrograde slows the vessel relative to Selene. Choosing a body fixes it.
- Burns are checked in order. A burn that starts in the past, overlaps the previous one or needs more propellant than is left is marked ✕ with the reason, and every burn after it is blocked. Only the valid prefix is flown or drawn.
- **Plan** (amber, burns orange): the trajectory through all valid burns, then a coast set by **Coast after last burn** (default 7 d, enough to reach Selene). Lengthening continues the integration already done; shortening restarts it. It is integrated from the vessel's state at the time of the last edit, up to 4,000 steps per frame. Apsides after the last burn are marked, along with any impact. When the frame is centred on a body, both the plan's and the prediction's apsides are measured from that body, as in Principia: plan in Aurelia's frame, switch the frame to Selene, and tune the Selene periapsis.
- **Target** (default Selene): its own future path over the same interval as the plan is drawn in amber. Rings mark where the vessel and the target are when the plan ends, and the readout gives the gap between them. Shorten or lengthen the coast to compare positions at a chosen time.
- Execution is automatic. At a burn's start time the engine runs at full thrust along the planned direction and the manual throttle is ignored. When the burn ends it leaves the list, and the rest of the plan continues from the new state. Manual thrust between burns re-plans from the new state, and burn durations follow the new mass.
- `Warp to burn` runs at maximum warp to 30 s before the next valid burn, then drops to 1×. `Space`, `,` and `.` cancel it.

## Status

| Phase | Scope | State |
|---|---|---|
| P1 | Ephemeris, vessel integrator, headless checks | done |
| P2 | Viewer: system, trajectories, time warp, reference frames | done |
| P3 | Vessel control, finite burns, prediction | done |
| P4 | Flight plan: burns, plan trajectory, execution | done |
| P5 | Realism: all planets, tidally locked moons, IAU spin axes, J2 for vessels | done |

The lab is paused here: nothing known is broken, and the next step is either another lab or merging this one into the game.

### Not modelled

- The massive bodies attract one another as point masses. J2 acts only on vessels, so the moons' orbits do not precess from their planet's bulge.
- Surfaces are spheres, and there is no atmosphere or drag. Lunar mascons are missing, so low lunar orbits are more stable than they really are.
- Spin axes are fixed in inertial space, with no precession or nutation.
- Attitude is ideal: thrust points exactly where commanded, with no turn time or rotational inertia.
- The start epoch is J2000-like, not an exact date.

### Open ideas (not scheduled)

- Hide Pe/Ap markers on near-circular orbits, for example when Ap − Pe < 1 km.
- Move throttle-down off `Ctrl`, so a slip can't trigger `Ctrl+W`.
- Optionally draw each slow planet's current orbit as a full ellipse.
- Make the engine parameters (thrust, Isp, masses) editable on the page.
- A closest-approach marker for the plan's target.
- Measure warp performance in a real browser (headless Chrome lags at 1e7× in low orbit).

## Core (`src/orbit/`)

All values are SI. The frame is ecliptic and right-handed, with +Z at ecliptic north, and its origin is the system barycenter.

- `SystemSpec.ts` builds initial state vectors from a body tree. Each child's elements are **Jacobi** elements: its subtree barycenter orbits the barycenter of its parent plus all earlier siblings. Planets listed after a companion star therefore orbit the binary's barycenter. The whole system is shifted to zero barycenter and zero momentum.
- `Ephemeris.ts` integrates the massive bodies with Yoshida's 8th-order symplectic composition, using a fixed step and Kahan-compensated positions. Every step stores position, velocity and acceleration, and any covered time is queried by quintic Hermite interpolation. Queries outside the integrated or retained interval throw. `forgetBefore` releases old chunks.
- `VesselPropagator.ts` integrates a massless vessel with adaptive Dormand–Prince 5(4) under absolute per-step position and velocity tolerances. Runs can be resumed with a step budget, and a budgeted run reproduces an uninterrupted one bit for bit. Surface impacts are screened along each step and then bisected with real integrated states to 0.1 ms.
- `FlightPlan.ts` turns planned burns into full-thrust schedules and checks them. It integrates the planned trajectory with the same propagator, and places a burn centred on an apsis. `Simulation.ts` flies the schedule, splitting integration legs exactly at burn start and end.
- `Kepler.ts` provides strict element/state conversion and osculating quantities. Hyperbolic and radial orbits report infinite apoapsis or period rather than invented values.

Defaults chosen from measurements in `orbit-check.ts`:

- Ephemeris step: 256 steps per tightest Jacobi periapsis passage. This gives 594 s for the Sol system, which is set by Ember's 1.77-day orbit. Against a half-size step over 60 days, the planets and Selene differ by millimetres and Io (Ember) by up to 0.4 m (about 1e-9 of its orbit, set by its resonant neighbours). Interpolation adds less than 0.1 mm. Energy drift over 10 years is about 3e-13, and 10 years of the 15-body system takes about 5 s.
- Vessel tolerances: 1e-4 m and 1e-7 m/s per step. This is about 250 steps per orbit, with 0.8 m error over 20 eccentric orbits against analytic Kepler.

## Fixtures (`src/app/SystemPresets.ts`)

- `sol`: the real Sun, the eight planets, the Moon, Jupiter's four Galilean moons and Saturn's Titan, under fictional names:

  | Lab | Real | | Lab | Real |
  |---|---|---|---|---|
  | Sol | Sun | | Velvet | Jupiter |
  | Cinder | Mercury | | Ember, Rime, Hollow, Umber | Io, Europa, Ganymede, Callisto |
  | Vesper | Venus | | Halo | Saturn |
  | Aurelia | Earth | | Haze | Titan |
  | Selene | Moon | | Azure | Uranus |
  | Ares | Mars | | Abyss | Neptune |

  - Planet elements are J2000 mean heliocentric elements. Spin axes come from the IAU pole directions; Venus and Uranus spin retrograde.
  - Each planet and large moon has its published J2, the oblateness term of its gravity field, with its reference radius. Vessels feel it: an inclined low orbit's node regresses (400 km at 51.6° about Aurelia: −5°/day, like the ISS), and its perigee rotates. The massive bodies still attract one another as point masses, and every surface is still a sphere. The start orbit uses the circular speed for the actual radial pull at the start point, bulge included, so an equatorial start stays at 400.00 km. In Selene's plane, 21° from the equator, the altitude varies by about 1 km, because under J2 an inclined orbit cannot be exactly circular.
  - Orbit elements are relative to the ecliptic, or, with `orbitPlane: 'parent-equator'`, to the parent's equator. The Galilean moons and Titan use the equator, since they orbit in their planet's equatorial plane; Titan's is 28° from the ecliptic. Saturn's small inner moons are left out because their sub-day orbits would shrink the ephemeris step.
  - The moons are tidally locked (`LockedRotationSpec`). Each spins at its real mean sidereal period, and its spin axis follows from its orbit: Selene's lies 6.68° from its orbit normal, on the far side of ecliptic north (Cassini state), so its equator is 1.54° from the ecliptic. Its near side faces the parent's mean direction, and over a year it stays within 8° of Aurelia (the real libration is ±7.9°).
  - Selene's initial semi-major axis is 381,487 km rather than the mean distance 384,400 km. Perturbed by the Sun, it then gives the real 27.3217-day sidereal month and a mean distance of 384,830 km. Starting at 384,400 km gives 27.64 days.
- `binary`: a circumbinary system in the spirit of the game's Astris Prime, using real-scale bodies.
