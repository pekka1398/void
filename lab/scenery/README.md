# Scenery Lab

How the planet looks: the atmosphere, the sea, volumetric clouds, the stars and the lit ground, on this lab's layered planet, lab/lod's continents or the Aurelia hills lab/flight flies over. Physics is not involved. The camera stands on the ground and can rise to 200,000 km.

```sh
cd lab/scenery
npm install
npm run dev        # the page
npm run check      # headless checks
npm run typecheck
npm run check:shader # generate the cloud composite GLSL without a browser
```

## Controls

- **Mouse.** The mapping is lab/lod's: left drag pans, right drag orbits the planet centre, Shift + left drag turns the view, and the wheel zooms (`src/OrbitView.ts`, after lab/lod's `OrbitCamera`). Three things differ so it also works at the ground:
  - Zoom and pan scale with the height above the ground or sea under the camera, not the distance to the centre. A wheel notch is about ×1.2 in height.
  - Orbiting slows the same way, at most lab/lod's 0.005 rad per pixel.
  - The view can tilt past the horizon to nearly straight up. The camera never goes below 1.5 m.
- **Time.** *Local time* is the solar time where the camera stands. *Time rate* runs it. *Sun declination* sets the season.
- **Toggles.** *Sea level*, *exposure* and *tone mapping* can be changed live, and the atmosphere, its multiple scattering, clouds, the ocean and the stars can each be switched off. *Cloud coverage* adjusts the weather threshold (it is not a literal percentage); *weather only* removes local 3D noise to inspect the global distribution.
- **Terrain.** Three choices; changing it reloads the page. `?terrain=layered` (default) is this lab's own planet (below). `?terrain=lod` is lab/lod's continents. `?terrain=hills` is lab/landing's Aurelia hills, which lab/flight uses.
- **Start point.** `?at=latitude,longitude` (degrees) sets the spot the camera starts over, for example `?at=22.5,-142`, the layered planet's highest range.
- **Presets.** Over the current spot, these jump to a height, pitch and time: ground at 10:00, sunset toward the west, night, the cloud layer at 3 km above sea level (raised if terrain is higher), 10 km, 400 km, and 20,000 km looking straight down.

## How it is drawn

Render space is the planet's body-fixed axes with the camera at the origin. The sun moves, and the planet does not turn. The sky is turned with the sun.

1. **Scene pass.** The scene is drawn into a half-float target with logarithmic depth. It holds lab/lod's tiles in `GroundMaterial` and the stars.
2. **Transport pass** (`AtmosphereShading.transport`, `SceneryPipeline`). At the same full resolution as the scene, regardless of camera motion, it reads scene depth and integrates air and clouds together in depth order. Cloud-shell intersections split each ray into at most five intervals, with 48 steps in cloud intervals below 100 km camera altitude, 24 farther away, and 32 in clear-air intervals. With clouds disabled or coverage at zero, it uses the original 32-step air march. Two half-float attachments store scattered light with a logarithmic scene-depth guide, and RGB transmission.
3. **Resolve pass.** Each full-resolution transport pixel directly supplies light and transmission for the matching scene pixel. The scene and sun disc are multiplied by transmission, then scattered light is added. Tone mapping and sRGB come last. There is no motion-dependent resolution switch, upsampling or delayed refinement frame. Canvas clicks without camera motion do not invalidate a settled frame.

**Render budget.** Drawing resolution is capped at 1920×1080 with DPR at most 1, frame rate at 30 fps, and terrain construction at two workers. Hidden tabs do not render. At heights above 20 km, a stopped clock and settled terrain render after interaction or a completed tile, using full-resolution transport for every rendered frame; near the surface the ocean remains animated. The panel reports the actual WebGL GPU and rendered-frame count. On Linux hybrid graphics, GPU selection belongs to browser launch, not the page.

Nested transport loops use distinct GLSL indices (`cloudSegment`, `viewStep`, `shadowStep`). Reusing Three's default `i` caused outer-segment expressions to use inner sample indices, marching outside the intended intervals and falsely illuminating the night side. `check:shader` verifies that generated loop names remain unique; browser regression checks include a fully dark orbital view with air, clouds and multiple scattering enabled. All atmosphere LUT reads explicitly use level 0: implicit derivative-based sampling inside divergent marching loops produced screen-horizontal bands on the tested GPU. Shader generation also checks that scene depth is the only remaining implicit-LOD sampler.

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

### Volumetric clouds (`src/CloudField.ts`, `src/CloudNodes.ts`)

Weather and volume stages are implemented, with full-resolution transport; the frame cap and on-demand rendering limit GPU load.

- **One field from ground to orbit.** A body-fixed shell starts 1.5 km above the live sea level and ends at 8 km. Weather and horizontally anchored banks set a local domed top below 8 km. The base stays level, gaps between banks remain clear, and local shape thresholds tighten with height. The density does not depend on terrain tiles or their LOD; a camera can cross the shell continuously.
- **Weather.** A 2048×1024 spherical atlas stores humidity and cloud type from domain-warped continuous 3D noise at continental and regional scales, modulated by latitude. Longitude wraps and the pole rows are constant. It does not yet reuse terrain moisture or model moving fronts. At the default setting, 63% of 6,000 equal-area directions have substantial weather coverage; about 51% of sampled columns contain local volume density.
- **Shape.** A repeating 64³ Perlin–Worley volume spans 65.536 km, with a second sample at 1,048.576 km for coherent banks that survive distant filtering. A low-frequency Perlin channel supplies the regional envelope, mixed with weaker cell structure; humid systems blend local cells into continuous sheets. A 32³ Worley erosion volume spans 2.048 km. A smooth vertical profile flattens the base and thins the top, while both the broad bank sample and local shape vary the top, and the local shape contracts with height. Both have mipmaps; sampling levels follow twice the ray-step or projected-pixel footprint to respect the sampling limit, and fine erosion fades when unresolved. The projected-pixel footprint uses the scene resolution and does not change when a drag starts or ends. Between 2 and 16 km footprints, thresholded local shape blends to a smooth coverage moment; this approximates subpixel coverage rather than thresholding the averaged noise. Sun-shadow samples use the same minimum footprint, preventing unresolved shadow noise from speckling distant tops.
- **Precision.** The CPU sends camera positions modulo each noise period. Near-camera heights use `(r² − R²)/(r + R)` with a CPU-supplied altitude; orbital heights use the planet-sized body-fixed vector. Orbital ray intersections use closest approach to the centre, avoiding cancellation of huge squared distances.
- **Light.** Atmospheric transmittance colours the sunlight and sky irradiance supplies ambient light. Five expanding samples estimate sun-ray cloud optical depth, capped at 120 km. A three-order approximation reduces anisotropy and optical depth for successive scattering orders, with a diffuse tail for higher orders. Cloud extinction is 0.0011 m⁻¹ at unit density; ambient and higher-order light attenuate inside thick banks to retain shadow contrast. This is not an exact cloud multiple-scattering solution.
- **Composition.** Cloud extinction and scattering enter the same Beer–Lambert integral as the air. Scene depth clips the volume at terrain or other scene geometry, and the same accumulated transmission dims the sun and stars. Very opaque rays stop accumulating below transmission 0.003.
- **Start-up.** Weather and noise take about 1.5 s on the tested browser, separately reported from sky-table building.
- **Browser checks.** Tested in Edge scenery tabs at ground, 3 km inside the layer, 10 km, 400 km and 20,000 km, plus sunset and zero coverage. No captured console errors or warnings. Cloud tops and interiors are visible. Orbital cloud edges and unresolved shadow speckle were revised after visual review; domed tops and clear bank gaps were additionally checked at 10 km and inside the layer; the coverage-moment and diffuse-light approximations still need tuning, and the far view still lacks temporal detail reconstruction.
- **Next stage.** GPU timing, temporal reprojection to recover cloud detail, and ground cloud shadows. Currently clouds are static, cast no shadows on terrain, and do not reduce the ground's sky irradiance. The atmosphere's multiple-scattering tables remain clear-sky tables. These visuals are now integrated into the main game (and its shared flight entry point); flight browser acceptance remains a separate step.

`npm run check:shader` bundles Three's source modules with its GLSL builder, builds the actual transport and resolve node graphs, and writes vertex/fragment GLSL into a temporary directory. It checks node generation; it does not create a graphics context. The generated shaders were additionally compiled and linked in an OpenGL ES 3 context during development.

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
- **Scope.** The main game's `src/sceneryCore.ts` imports the shading, cloud, star and pipeline modules directly. `src/FlightScenery.ts` supplies body-fixed positions, the render-to-body rotation and the terrain's separate render origin. This lab keeps its camera-relative body-fixed setup, which uses the identity render rotation. Landing's `TerrainConfig` reconstructs the pure layered sampler for both collision tiles and the visual worker, including each tile's cell size.

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

`cloud-check.ts` (run by `npm run check`):

- Sea-relative shell intervals from ground, orbit and inside, including grazing rays, both sides of the shell, and clipping at scene depth.
- Equal-area weather/volume coverage, atlas interpolation, longitude and periodic 3D noise continuity.
- Bounded density, empty space above/below the layer, zero coverage, and monotonic coverage control.
- Homogeneous volume integration against the analytic Beer–Lambert solution.
