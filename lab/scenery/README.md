# Scenery Lab

How the planet looks: the atmosphere, the sea, the stars and the lit ground, on this lab's layered planet, lab/lod's continents or the Aurelia hills lab/flight flies over. Physics is not involved. The camera stands on the ground and can rise to 200,000 km.

```sh
cd lab/scenery
npm install
npm run dev        # the page
npm run check      # headless checks
npm run typecheck
```

## Controls

- **Mouse.** The mapping is lab/lod's: left drag pans, right drag orbits the planet centre, Shift + left drag turns the view, and the wheel zooms (`src/OrbitView.ts`, after lab/lod's `OrbitCamera`). Three things differ so it also works at the ground:
  - Zoom and pan scale with the height above the ground or sea under the camera, not the distance to the centre. A wheel notch is about ×1.2 in height.
  - Orbiting slows the same way, at most lab/lod's 0.005 rad per pixel.
  - The view can tilt past the horizon to nearly straight up. The camera never goes below 1.5 m.
- **Time.** *Local time* is the solar time where the camera stands. *Time rate* runs it. *Sun declination* sets the season.
- **Toggles.** *Sea level*, *exposure* and *tone mapping* can be changed live, and the atmosphere, its multiple scattering, the ocean and the stars can each be switched off.
- **Terrain.** Three choices; changing it reloads the page. `?terrain=layered` (default) is this lab's own planet (below). `?terrain=lod` is lab/lod's continents. `?terrain=hills` is lab/landing's Aurelia hills, which lab/flight uses.
- **Start point.** `?at=latitude,longitude` (degrees) sets the spot the camera starts over, for example `?at=22.5,-142`, the layered planet's highest range.
- **Presets.** Over the current spot, these jump to a height, pitch and time: ground at 10:00, sunset toward the west, night, 10 km, 400 km, and 20,000 km looking straight down.

## How it is drawn

Render space is the planet's body-fixed axes with the camera at the origin. The sun moves, and the planet does not turn. The sky is turned with the sun.

1. **Scene pass.** The scene is drawn into a half-float target with logarithmic depth. It holds lab/lod's tiles in `GroundMaterial` and the stars.
2. **Composite pass** (`AtmosphereShading.composite`). For every pixel it reads the depth, finds the ray's stretch inside the air (up to what was drawn, the ground sphere, or the top of the air) and marches it in 32 steps. The steps crowd toward the camera.
   - The scene colour is dimmed by the air's transmittance.
   - Light the air scatters toward the camera is added: Rayleigh and Mie, each with a phase function, sunlit through the transmittance table.
   - The sun's limb-darkened disc is added to sky pixels.
   - Tone mapping and sRGB come last.

### Atmosphere (`src/Atmosphere.ts`)

- **Model.** Single scattering with Earth's values, from Hillaire 2020 and Bruneton:
  - Rayleigh, scale height 8 km.
  - Mie, 1.2 km scale height, g = 0.8.
  - An ozone layer, a tent at 25 km, 30 km wide.
  - The top of the air is 100 km up.
- **Transmittance table.** It is 256×64 and built on the CPU at start-up. It uses Hillaire's layout and is uploaded as half floats, so linear filtering works on any WebGL2 device.
  - Sunlight below the ground sphere's horizon is cut off, softened over the sun's radius; this gives the Earth's shadow at dusk.
- **Precision.** The camera's height reaches the shader from the CPU in float64. The ray–sphere tests use `altitude · (2R + altitude)` instead of subtracting two 6,371 km squares in float32.
- **Multiple scattering** (`src/SkyTables.ts`). This follows Hillaire's 32×32 table Ψ(height, sun angle). Built from the transmittance table, it holds:
  - second-order light from 64 directions, including a bounce off 30%-albedo ground;
  - the share of light the air re-scatters, f;
  - Ψ = L₂ / (1 − f), which sums all orders.

  The sky pass adds `σ_s · Ψ` as an isotropic source at every step. It brightens the noon zenith by about 60% (blue) and the twilight sky 2.4×.
- **Sky irradiance.** A 32×16 table of the light the whole sky (multiple scattering included, without the sun's beam) casts on level ground. It is integrated over 64 hemisphere directions and is within 2% of 512.
- **Start-up cost.** All three tables are built on the CPU at start-up, in about 0.6 s in the browser. The page shows the time.
- **Not modelled yet.** There are no clouds.

### Layered terrain (`src/LayeredTerrain.ts`)

A planet built in layers, each at its own scale, so it reads as a planet from 20,000 km and as ground from 2 m. Heights are measured from the ocean floor's reference sphere, since lab/lod needs heights of 0 or more; sea level is 5,000 m above it.

1. **Continents** (thousands of km). Domain-warped fBm; its sign decides land or sea.
   - The sea falls to a 150 m shelf, then to basins about 4.5 km deep.
   - The land rises slowly inland, to about 500 m.
2. **Mountain belts** (hundreds of km). Narrow bands along the zero lines of a low-frequency noise, like ranges along plate edges. They lie on land and at coasts, and their strength varies along each belt. Inside a belt, ridged multifractal noise (Musgrave) builds ranges with wavelengths from 220 km down to 1.5 km.
3. **Hills, down to 8 m.** Quilez's "eroded" fBm: gradient noise with an analytic gradient, where each octave is damped by the slope the coarser octaves have already built. Slopes grow gullies and spurs, and flat ground stays flat.
   - Roughness depends on the region and is highest in the belts.
   - The sea floor is gentler.

**Ground cover.** The sampler also returns what covers the land, as the tile's vertex colour: desert, steppe, grass, forest, or tundra toward the poles.
- It depends on a continental-scale wetness, which is dried in the subtropical belts (about 25° from the equator), in mountain belts and with height.
- Patches from 6.4 km down to 25 m break it up, band-limited like the heights.

**Band limit.** lab/lod now passes the tile's cell size to the sampler. Octaves shorter than 4 cells fade out, and they are gone at 2 cells, as in a mipmap, so coarse tiles do not alias detail they cannot hold. The camera stands on the full-detail surface.

**Measured** (`npm run check`, 6,000 random points):
- 34% of the surface is land.
- The highest peak is about 9.1 km, and the deepest basin 4.6 km.
- Slopes on plains stay under 9° at 10 m, 100 m and 1 km spacing, with a median of 0.3–0.5°.
- Slopes in mountains (above 2.5 km) have a median of 10.7°, 8.6° and 6.3° at those spacings, and a 99th percentile of 34°, 31° and 30°. They rise smoothly toward small scales, with no scale where the ground turns suddenly rough.
- Inside a belt, the ridged signal is squared, so the valleys between ridges stay low instead of forming one raised plateau.

A 33×33 tile takes about 3 ms to build in Node.

### Ground and sea (`src/GroundMaterial.ts`)

- **Sunlight.** It is `N·L` times the sunlight left after the air (from the table), so the ground reddens at sunset and is black past the terminator.
- **Sky light.** It comes from the sky-irradiance table at the point's height and sun angle. A tilted surface gets (1 + N·up)/2 of it. A night floor of 2×10⁻⁴ of sunlight stands in for starlight and airglow, about a hundred times too bright, so the night side is dim rather than black.
- **Land colour.** It starts from the tile's vertex colour (the layered planet's ground cover). The shader adds sand within about 10 m of the sea, and bare rock on steep ground and above the terrain's rock height; the higher the ground, the gentler the slope that turns to rock.
- **Snow.** It lies on flat ground above a snow line that falls toward the poles, to 30% of its height above the sea there.
- **Sub-mesh detail.** Value noise from 256 m down to 1 m mottles the land. It repeats every 4096 m on each axis, like the waves, so it has no seam. Each octave fades out where it is under a pixel. The terrain's vertex colour is not used.
- **Sea.** lab/lod's tiles now carry each vertex's height.
  - Vertices below sea level are raised onto the sea sphere in the vertex shader. The coast is where the interpolated height crosses sea level.
  - Sea level is a uniform, so the slider needs no rebuild.
  - The sea's colour depends on depth: the bed shows through the first few metres.
  - It reflects the sky's average radiance (irradiance over π), up to twice as bright at grazing angles where the horizon sky shows, weighted by Fresnel.
  - A sun glint is shaped by four deep-water waves. Where the waves are too small to draw (from orbit), the glint becomes a broad, dim lobe, the way sun glitter looks from space.
  - The four waves: Their wave vectors are whole multiples of 2π/4096 m on each axis, so the camera's position is passed modulo 4096 m without a seam. Each wave fades out where it is smaller than a pixel.
- **Collision.** Rapier's collision ground (lab/landing) is unaffected: the sea is only drawn.

### Stars (`src/Stars.ts`)

- **Field.** There are 14,000 one-pixel points 10¹² m away. 55% of them crowd within a Gaussian band of 8° around a galactic plane, which draws the Milky Way.
- **Brightness.** Brightness falls as 10^(−0.25 m), flatter than the real 10^(−0.4 m), so faint stars still show on a display.
- **Daylight.** Stars fade where the camera is in sunlit air, which stands in for the eye's adaptation. The air in the composite pass also dims them.

## Boundary

- **Imports.** It imports lab/lod's core (`src/lodCore.ts`) and lab/landing's Aurelia and terrain worker (`src/landingCore.ts`).
- **Changes to lab/lod for this lab.**
  - Samplers receive the tile's nominal cell size (`SurfaceSampler(direction, cellMeters)`). Samplers that ignore it are unchanged.
  - `TileMeshData.heights`: the per-vertex height above the reference radius, stitched across LOD seams like the positions.
  - A `height` vertex attribute.
  - `TileRenderer.setMaterial`, so a caller can shade the tiles itself.
- **Scope.** `AtmosphereShading` and `GroundMaterial` know nothing about the page and are what lab/flight would take over later.

## Checks

`scenery-check.ts`:

- **Transmittance.**
  - Zenith transmittance equals the flat-atmosphere integral.
  - It dims monotonically toward the horizon and is red on the horizon.
  - The table coordinates round-trip.
  - The bilinear table lookup matches direct integration within 0.004.
- **Multiple scattering and sky irradiance.**
  - The tables are finite and non-negative.
  - Ψ brightens the noon sky by 10–80%, and more in twilight.
  - Sky light is 5–25% of daylight at noon, fades monotonically as the sun sets, and is gone at night.
  - The irradiance table agrees with a 512-direction integral within 5%.
- **Sky.** A 2,000-step reference gives a blue zenith at noon, a red sky toward the sun at sunset, and darkness overhead at the top of the air.
- **Shader march.** A CPU port of the shader's 32-step march with table lookups agrees with the reference within 1% on six rays, from the ground, from 10 km and from 99 km.
- **Stars.** They lie on the sky sphere, and the band is crowded.
- **Layered terrain.**
  - The noise gradient matches central differences.
  - The land fraction, and the heights of peaks and basins, are Earth-like.
  - The band limit at 1 km cells moves the ground by under 400 m.
  - Plains are gentle and mountains steep but not cliffs, at 10 m, 100 m and 1 km.
  - Mountain slopes change smoothly with scale.
- **Orbit view.** Its basis stays orthonormal after mixed drags, zoom keeps the point under the camera, it can be placed on the pole, it tilts to nearly straight up, and heading 0 looks north.
