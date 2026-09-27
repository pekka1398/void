# Navball Lab

The attitude ball, on its own. Sliders set the vessel's attitude, its velocity and the latitude; `WASDQE` turn the vessel about its own axes the way lab/flight's steering does. The same ball is drawn at 320 px and at 150 px, the size lab/flight uses.

```sh
cd lab/navball
npm install
npm run dev        # the page
npm run check      # headless geometry checks
npm run typecheck
```

## The ball

- **Orientation.** The ball is seen from outside along the nose. Its centre is where the nose points, screen up is the vessel's top (where the nose goes on pitch up), and screen right is the vessel's right. Rolling the vessel turns the ball.
- **Sky and ground.** The upper half, toward the local vertical, is blue; the lower half is brown. Both are shaded per pixel and darken toward the rim.
- **Lines.** Pitch circles are every 10° (brighter every 30°), and the horizon is white. Heading meridians are every 30°.
- **Labels.** Headings are marked N, 30, 60, E, … just above the horizon. Pitch ±30 and ±60 ride the meridian under the nose. Only the front of the ball is labelled.
- **Markers.**
  - Prograde is a yellow circle with three ticks; retrograde is a circle with a cross.
  - Both are hidden behind the ball, and below 0.1 m/s, where the velocity has no useful direction.
  - The orange mark at the centre is the vessel.
- **Readout.** `draw` returns the nose's heading and pitch and the speed.

## Boundary

`src/Navball.ts` takes plain vectors in any one frame: `nose`, `top`, `up` (local vertical), `pole` (the body's spin axis), `primeMeridian` (longitude 0 on the equator) and `velocity`. The caller picks the frame and the velocity (surface or orbit); the ball has no idea which planet it is on.

It panics instead of guessing:

- Non-unit vectors.
- A nose and top that are not perpendicular (tolerance 1e-5).
- A prime meridian off the equator.

**Poles.** A vessel over a pole is a legal state, but no north can be continuous over the whole sphere (the hairy ball theorem). So the pole has its own definition:

- Where `pole × up` is zero to double precision (under 1e-12), the ball uses grid north, which points along the prime meridian.
- Everywhere else it uses true north.
- Crossing close to a pole still swings the heading quickly from 000 to 180; that is real, not a flaw. The latitude slider reaches ±90° to show it.

The main game imports it through the repository's root `src/navballCore.ts`. lab/flight runs that same game entry point, and its check verifies that the ball's screen axes agree with the steering keys.

## Checks

`navball-check.ts`:

- A standing rocket with its top to the north shows the zenith at the centre, north at the top and east at the right.
- Heading and pitch round-trip to 1e-9°.
- In level flight east, prograde is at the centre, retrograde is hidden, and a 10° climb puts the marker sin 10° above the centre.
- Every horizon from the equator to exactly ±90° is a right-handed frame.
- At both poles, the prime meridian reads HDG 000.
- The panics above.
