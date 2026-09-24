import * as THREE from 'three';
import { material, PALETTE } from '../style/Palette';

export interface ShipVisual {
  group: THREE.Group;
  setThrottle: (amount: number, mode: string, speedMetersPerSecond?: number) => void;
  update: (elapsed: number, bank: number, deltaSeconds?: number) => void;
  dispose: () => void;
  installAuthoredModel?: (model: THREE.Group, options: AuthoredShipModelOptions) => boolean;
  /** Convert the legacy camera-display assembly to native glTF meters, once. */
  promoteToPhysicalMeters?: () => boolean;
}

export interface AuthoredShipModelOptions {
  assetId: string;
  assetName?: string;
  assetUrl: string;
  scale: number;
  nozzleRadius: number;
  materialCount: number;
  opaqueMeshCount: number;
  emissiveMeshCount: number;
  materialRoles: readonly string[];
  nodeMaterials: boolean;
  transmissionPasses: number;
}

type PlanformPoint = readonly [number, number];

/** Closed low-poly XZ-planform with visible faceted top, bottom, and sidewalls. */
function planform(outline: readonly PlanformPoint[], thickness: number): THREE.BufferGeometry {
  const points = [...outline];
  const signedArea = points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0);
  // Clockwise X/Z vertex order gives an upward (+Y) top-surface normal.
  if (signedArea > 0) points.reverse();

  const vertices: number[] = [];
  const face = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => vertices.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  const upper = thickness / 2;
  const lower = -upper;

  for (let index = 1; index < points.length - 1; index += 1) {
    const first = points[0]!;
    const second = points[index]!;
    const third = points[index + 1]!;
    face(first[0], upper, first[1], second[0], upper, second[1], third[0], upper, third[1]);
    face(first[0], lower, first[1], third[0], lower, third[1], second[0], lower, second[1]);
  }

  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!;
    const second = points[(index + 1) % points.length]!;
    face(first[0], upper, first[1], first[0], lower, first[1], second[0], lower, second[1]);
    face(first[0], upper, first[1], second[0], lower, second[1], second[0], upper, second[1]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function diamondWedge(width: number, height: number, length: number): THREE.BufferGeometry {
  const top = height * 0.48;
  const base = -height * 0.48;
  const tip = -length * 0.63;
  const tail = length * 0.43;
  const shoulder = length * 0.12;
  const vertices = new Float32Array([
    0, top, tip, -width / 2, base, tail, 0, top * 0.7, shoulder,
    0, top, tip, 0, top * 0.7, shoulder, width / 2, base, tail,
    0, top * 0.7, shoulder, -width / 2, base, tail, width / 2, base, tail,
    0, top, tip, width / 2, base, tail, -width / 2, base, tail,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Shape genuine dorsal and ventral surfaces without adding vertices, faces, or draws. */
function sculptFuselage(
  geometry: THREE.BufferGeometry,
  dorsalRise: number,
  ventralDepth: number,
): THREE.BufferGeometry {
  const positions = geometry.getAttribute('position');
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const width = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x), 0.001);
  const length = Math.max(bounds.max.z - bounds.min.z, 0.001);

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const centerline = Math.pow(Math.max(0, 1 - Math.abs(x) / width), 0.72);
    const longitudinal = THREE.MathUtils.clamp((z - bounds.min.z) / length, 0, 1);
    const shoulder = 0.18 + Math.sin(longitudinal * Math.PI) * 0.82;
    const volume = centerline * shoulder;
    positions.setY(index, y + (y >= 0 ? dorsalRise * volume : -ventralDepth * volume));
  }

  positions.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  return geometry;
}

/** Give real swept-wing vertices a descending dihedral instead of a flat planar slab. */
function sculptWingDihedral(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const positions = geometry.getAttribute('position');
  for (let index = 0; index < positions.count; index += 1) {
    const span = THREE.MathUtils.clamp((Math.abs(positions.getX(index)) - 0.38) / 2.05, 0, 1);
    positions.setY(index, positions.getY(index) + 0.065 - span * 0.145);
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** Vary real opaque panel facets without adding either triangles or draw calls. */
function shadeArmorFacets(geometry: THREE.BufferGeometry, coolAccent = 0): THREE.BufferGeometry {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const colors = new Float32Array(positions.count * 3);

  for (let index = 0; index < positions.count; index += 3) {
    const centerX = (
      positions.getX(index) + positions.getX(index + 1) + positions.getX(index + 2)
    ) / 3;
    const centerZ = (
      positions.getZ(index) + positions.getZ(index + 1) + positions.getZ(index + 2)
    ) / 3;
    const upward = THREE.MathUtils.clamp(normals.getY(index) * 0.5 + 0.5, 0, 1);
    const seam = 0.055 * (0.5 + 0.5 * Math.sin(centerZ * 5.1 + Math.abs(centerX) * 3.2));
    const brightness = THREE.MathUtils.clamp(0.79 + upward * 0.2 - seam, 0.73, 1);
    const cool = coolAccent * (1 - upward) * 0.25;

    for (let corner = 0; corner < 3; corner += 1) {
      const colorOffset = (index + corner) * 3;
      colors[colorOffset] = brightness - cool * 0.32;
      colors[colorOffset + 1] = brightness + cool * 0.16;
      colors[colorOffset + 2] = Math.min(1, brightness + cool);
    }
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Sculpt the existing twelve-triangle nacelle rather than adding hidden greebles. */
function taperedNacelle(width: number, height: number, length: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, length);
  const positions = geometry.getAttribute('position');

  for (let index = 0; index < positions.count; index += 1) {
    const depth = positions.getZ(index) / length + 0.5;
    const shoulder = positions.getY(index) > 0 ? 0.87 : 1;
    positions.setXYZ(
      index,
      positions.getX(index) * (0.78 + depth * 0.22) * shoulder,
      positions.getY(index) * (0.91 + depth * 0.09),
      positions.getZ(index),
    );
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** Combine matched low-poly armor pieces into one opaque foreground draw. */
function joinFacetedParts(
  parts: readonly { geometry: THREE.BufferGeometry; x?: number; y?: number; z?: number }[],
): THREE.BufferGeometry {
  const vertices: number[] = [];
  for (const part of parts) {
    const positions = part.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index += 1) {
      vertices.push(
        positions.getX(index) + (part.x ?? 0),
        positions.getY(index) + (part.y ?? 0),
        positions.getZ(index) + (part.z ?? 0),
      );
    }
    part.geometry.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Two thin crossed translucent planes read as cyan ribbons, not solid green cylinders. */
function taperedRibbon(width: number): THREE.BufferGeometry {
  const tip = width * 0.075;
  const positions = new Float32Array([
    -width, 0, 0, width, 0, 0, -tip, 0, 1,
    width, 0, 0, tip, 0, 1, -tip, 0, 1,
    0, -width * 0.62, 0, 0, width * 0.62, 0, 0, -tip * 0.62, 1,
    0, width * 0.62, 0, 0, tip * 0.62, 1, 0, -tip * 0.62, 1,
  ]);
  const colors = new Float32Array(positions.length);
  for (let index = 0; index < positions.length; index += 3) {
    const rear = positions[index + 2]! > 0.5;
    colors[index] = rear ? 0.18 : 1;
    colors[index + 1] = rear ? 0.74 : 1;
    colors[index + 2] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function createProceduralShip(): ShipVisual {
  const group = new THREE.Group();
  group.name = 'VOIDRUNNER / VE-07';

  // Warm fill keeps the faceted hull recognizably ivory when both real suns sit
  // on the horizon; it preserves directional shading without adding a light.
  const ivory = material(PALETTE.ivory, { roughness: 0.56, emissive: 0xe8c69c, emissiveIntensity: 0.76 });
  const upperIvory = material(0xfff6e8, { roughness: 0.47, emissive: 0xf1d9b5, emissiveIntensity: 0.82 });
  const navy = material(0x211a61, { roughness: 0.58, emissive: 0x382184, emissiveIntensity: 0.39 });
  const deepNavy = material(0x11142f, { roughness: 0.64, emissive: 0x211843, emissiveIntensity: 0.18 });
  const panel = material(0xd9deec, { roughness: 0.45, emissive: 0xc7aa9a, emissiveIntensity: 0.37 });
  const seam = material(0x493c82, { roughness: 0.57, emissive: 0x3d1d72, emissiveIntensity: 0.3 });
  const engineTrim = material(0x15475f, { roughness: 0.31, emissive: 0x0763aa, emissiveIntensity: 0.52 });
  const sculptedIvory = upperIvory.clone();
  sculptedIvory.vertexColors = true;
  const sculptedIndigo = navy.clone();
  sculptedIndigo.vertexColors = true;
  const canopy = material(0x0799b8, {
    emissive: 0x03badf,
    emissiveIntensity: 0.66,
    transparent: true,
    opacity: 0.91,
    roughness: 0.16,
    metalness: 0.38,
  });

  const hull = new THREE.Mesh(sculptFuselage(planform([
    [0, -2.24], [-0.46, -1.24], [-0.76, -0.21], [-0.59, 1.02],
    [0.59, 1.02], [0.76, -0.21], [0.46, -1.24],
  ], 0.52), 0.135, 0.12), ivory);
  hull.name = 'Opaque ivory primary hull';
  hull.position.y = -0.03;
  group.add(hull);

  const topDeck = new THREE.Mesh(shadeArmorFacets(sculptFuselage(planform([
    [0, -1.87], [-0.43, -1.1], [-0.59, -0.1], [-0.46, 0.78],
    [0.46, 0.78], [0.59, -0.1], [0.43, -1.1],
  ], 0.19), 0.11, 0.025)), sculptedIvory);
  topDeck.name = 'Opaque faceted upper hull plates';
  topDeck.position.y = 0.265;
  group.add(topDeck);

  const undershield = new THREE.Mesh(sculptFuselage(planform([
    [0, -1.91], [-0.54, -0.7], [-0.45, 0.95], [0.45, 0.95], [0.54, -0.7],
  ], 0.255), 0.035, 0.11), deepNavy);
  undershield.name = 'Opaque sculpted deep-indigo ventral shield';
  undershield.position.y = -0.355;
  group.add(undershield);

  // A raised faceted flight deck remains a long swept canopy, never an upright cone.
  const canopyBase = new THREE.Mesh(planform([
    [0, -1.23], [-0.34, -0.85], [-0.34, -0.1], [-0.235, 0.1],
    [0.235, 0.1], [0.34, -0.1], [0.34, -0.85],
  ], 0.09), deepNavy);
  canopyBase.name = 'Recessed angular cockpit surround';
  canopyBase.position.y = 0.402;
  group.add(canopyBase);

  const canopyGlass = new THREE.Mesh(diamondWedge(0.58, 0.45, 1.16), canopy);
  canopyGlass.name = 'Deliberately translucent teal cockpit canopy';
  canopyGlass.position.set(0, 0.55, -0.58);
  group.add(canopyGlass);

  const canopyFrame = new THREE.Mesh(joinFacetedParts([
    { geometry: diamondWedge(0.073, 0.13, 0.94), x: -0.278, z: -0.57 },
    { geometry: diamondWedge(0.073, 0.13, 0.94), x: 0.278, z: -0.57 },
  ]), deepNavy);
  canopyFrame.name = 'Paired sculpted dark-teal cockpit frame strakes';
  canopyFrame.position.y = 0.485;
  group.add(canopyFrame);

  const noseChevron = new THREE.Mesh(diamondWedge(0.29, 0.096, 0.62), panel);
  noseChevron.name = 'Angular forward ivory navigation chine';
  noseChevron.position.set(0, 0.376, -1.47);
  group.add(noseChevron);

  const dorsalPanel = new THREE.Mesh(planform([
    [-0.25, -0.07], [-0.29, 0.55], [-0.13, 0.79], [0.13, 0.79], [0.29, 0.55], [0.25, -0.07],
  ], 0.09), panel);
  dorsalPanel.name = 'Faceted rear fuselage armor';
  dorsalPanel.position.y = 0.395;
  group.add(dorsalPanel);

  const aftMantle = new THREE.Mesh(shadeArmorFacets(sculptFuselage(planform([
    [-0.37, -0.01], [-0.51, 0.34], [-0.38, 1.08],
    [0.38, 1.08], [0.51, 0.34], [0.37, -0.01],
  ], 0.14), 0.1, 0.015)), sculptedIvory);
  aftMantle.name = 'Raised faceted ivory aft command mantle';
  aftMantle.position.y = 0.425;
  group.add(aftMantle);

  const shoulderArmor = new THREE.Mesh(joinFacetedParts([-1, 1].map((side) => ({
    geometry: planform([
      [side * 0.32, 0.12],
      [side * 0.81, 0.31],
      [side * 0.91, 0.93],
      [side * 0.55, 1.19],
      [side * 0.35, 0.67],
    ], 0.12),
  }))), ivory);
  shoulderArmor.name = 'Paired opaque sculpted ivory aft-engine shoulder armor';
  shoulderArmor.position.y = 0.31;
  group.add(shoulderArmor);

  const dorsalSpine = new THREE.Mesh(planform([
    [0, -0.12], [-0.09, 0.16], [-0.08, 0.89], [0.08, 0.89], [0.09, 0.16],
  ], 0.07), upperIvory);
  dorsalSpine.name = 'Raised ivory dorsal flight spine';
  dorsalSpine.position.y = 0.51;
  group.add(dorsalSpine);

  const rearCrossmember = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.36, 0.43), deepNavy);
  rearCrossmember.name = 'Recessed twin-engine structural bridge';
  rearCrossmember.position.set(0, -0.105, 0.99);
  group.add(rearCrossmember);

  const magentaMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.magenta, toneMapped: false });
  const cyanCoreMaterial = new THREE.MeshBasicMaterial({ color: 0x00eaff, toneMapped: false });
  const cyanInnerMaterial = new THREE.MeshBasicMaterial({ color: 0xe5ffff, toneMapped: false });
  const navigationMaterial = new THREE.MeshBasicMaterial({ color: 0x40e5f0, toneMapped: false });
  const sensorMaterial = new THREE.MeshBasicMaterial({ color: 0xffc37c, toneMapped: false });
  const ribbonCoreMaterial = new THREE.MeshBasicMaterial({
    color: 0x53dcff,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const ribbonHaloMaterial = new THREE.MeshBasicMaterial({
    color: 0x168eff,
    vertexColors: true,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const engineCores: THREE.Mesh[] = [];
  const engineRibbons: Array<{ root: THREE.Group; core: THREE.Mesh; halo: THREE.Mesh }> = [];

  for (const side of [-1, 1]) {
    const outline: PlanformPoint[] = [
      [side * 0.39, -1.17],
      [side * 1.08, -0.39],
      [side * 2.43, 0.46],
      [side * 2.31, 0.76],
      [side * 1.22, 0.94],
      [side * 0.55, 0.56],
    ];
    const wing = new THREE.Mesh(
      shadeArmorFacets(sculptWingDihedral(planform(outline, 0.235)), 0.65),
      sculptedIndigo,
    );
    wing.name = side < 0 ? 'Opaque swept port wing' : 'Opaque swept starboard wing';
    wing.position.y = -0.045;
    group.add(wing);

    const inboardPanel = new THREE.Mesh(sculptWingDihedral(planform([
      [side * 0.49, -0.87],
      [side * 1.03, -0.2],
      [side * 1.63, 0.29],
      [side * 1.23, 0.43],
      [side * 0.62, 0.15],
    ], 0.052)), upperIvory);
    inboardPanel.name = `${side < 0 ? 'Port' : 'Starboard'} sculpted ivory wing root`;
    inboardPanel.position.y = 0.085;
    group.add(inboardPanel);

    const leadingStrake = new THREE.Mesh(planform([
      [side * 0.52, -1.18],
      [side * 1.01, -0.55],
      [side * 0.91, -0.35],
      [side * 0.51, -0.81],
    ], 0.028), panel);
    leadingStrake.position.y = 0.092;
    group.add(leadingStrake);

    const outerRail = new THREE.Mesh(planform([
      [side * 1.36, 0.08],
      [side * 2.27, 0.53],
      [side * 2.16, 0.66],
      [side * 1.24, 0.27],
    ], 0.018), seam);
    outerRail.name = `${side < 0 ? 'Port' : 'Starboard'} violet swept outer edge`;
    outerRail.position.y = -0.016;
    group.add(outerRail);

    const wingInset = new THREE.Mesh(planform([
      [side * 1.15, -0.09], [side * 2.06, 0.51], [side * 1.89, 0.61], [side * 1.19, 0.15],
    ], 0.014), seam);
    wingInset.position.y = 0.012;
    group.add(wingInset);

    const seamLine = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.026, 0.45), deepNavy);
    seamLine.rotation.y = side * 0.56;
    seamLine.position.set(side * 0.85, 0.13, 0.035);
    group.add(seamLine);

    const navigationStrip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.018, 0.24), navigationMaterial);
    navigationStrip.rotation.y = side * 0.94;
    navigationStrip.position.set(side * 1.76, 0.015, 0.38);
    group.add(navigationStrip);

    const wingtip = new THREE.Mesh(new THREE.OctahedronGeometry(0.096, 0), magentaMaterial);
    wingtip.name = side < 0 ? 'Magenta port navigation wingtip' : 'Magenta starboard navigation wingtip';
    wingtip.scale.set(1.08, 0.58, 1.32);
    wingtip.position.set(side * 2.38, -0.115, 0.64);
    group.add(wingtip);

    const stabilizer = new THREE.Mesh(diamondWedge(0.105, 0.35, 0.57), deepNavy);
    stabilizer.position.set(side * 0.41, 0.295, 0.68);
    group.add(stabilizer);

    const enginePod = new THREE.Mesh(taperedNacelle(0.53, 0.48, 1.06), deepNavy);
    enginePod.name = side < 0 ? 'Opaque port sculpted thruster nacelle' : 'Opaque starboard sculpted thruster nacelle';
    enginePod.position.set(side * 0.51, -0.096, 1.02);
    group.add(enginePod);

    const enginePanel = new THREE.Mesh(new THREE.BoxGeometry(0.405, 0.075, 0.73), panel);
    enginePanel.name = `${side < 0 ? 'Port' : 'Starboard'} ivory nacelle armor`;
    enginePanel.position.set(side * 0.51, 0.176, 0.91);
    group.add(enginePanel);

    const engineShoulder = new THREE.Mesh(diamondWedge(0.2, 0.15, 0.37), ivory);
    engineShoulder.position.set(side * 0.52, 0.242, 0.64);
    group.add(engineShoulder);

    const engineHousing = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.258, 0.37, 8), seam);
    engineHousing.name = side < 0 ? 'Faceted port octagonal exhaust housing' : 'Faceted starboard octagonal exhaust housing';
    engineHousing.rotation.x = Math.PI / 2;
    engineHousing.position.set(side * 0.51, -0.096, 1.51);
    group.add(engineHousing);

    const outerNozzle = new THREE.Mesh(new THREE.RingGeometry(0.214, 0.267, 8), navy);
    outerNozzle.name = side < 0 ? 'Port octagonal navy rear nozzle shroud' : 'Starboard octagonal navy rear nozzle shroud';
    outerNozzle.position.set(side * 0.51, -0.096, 1.698);
    group.add(outerNozzle);

    const nozzleCollar = new THREE.Mesh(new THREE.RingGeometry(0.177, 0.237, 8), engineTrim);
    nozzleCollar.name = side < 0 ? 'Port faceted cyan nacelle collar' : 'Starboard faceted cyan nacelle collar';
    nozzleCollar.position.set(side * 0.51, -0.096, 1.701);
    group.add(nozzleCollar);

    const exhaustRing = new THREE.Mesh(new THREE.RingGeometry(0.111, 0.179, 8), cyanCoreMaterial);
    exhaustRing.name = side < 0 ? 'Electric-cyan port ion aperture' : 'Electric-cyan starboard ion aperture';
    exhaustRing.position.set(side * 0.51, -0.096, 1.706);
    group.add(exhaustRing);

    const exhaustCore = new THREE.Mesh(new THREE.CircleGeometry(0.105, 8), cyanInnerMaterial);
    exhaustCore.name = side < 0 ? 'White-hot port ion core' : 'White-hot starboard ion core';
    exhaustCore.position.set(side * 0.51, -0.096, 1.71);
    engineCores.push(exhaustCore);
    group.add(exhaustCore);

    const ionFocus = new THREE.Mesh(new THREE.RingGeometry(0.066, 0.113, 8), cyanCoreMaterial);
    ionFocus.name = side < 0 ? 'Port nested electric-cyan ion focusing stage' : 'Starboard nested electric-cyan ion focusing stage';
    ionFocus.position.set(side * 0.51, -0.096, 1.714);
    group.add(ionFocus);

    const trailRoot = new THREE.Group();
    trailRoot.name = side < 0 ? 'Twin port tapered ion plume' : 'Twin starboard tapered ion plume';
    trailRoot.position.set(side * 0.51, -0.096, 1.72);
    const halo = new THREE.Mesh(taperedRibbon(0.235), ribbonHaloMaterial);
    const core = new THREE.Mesh(taperedRibbon(0.137), ribbonCoreMaterial);
    halo.name = 'Translucent cyan exhaust scattering';
    core.name = 'Translucent electric-cyan exhaust core';
    trailRoot.add(halo, core);
    group.add(trailRoot);
    engineRibbons.push({ root: trailRoot, core, halo });
  }

  const rearBridge = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.28, 0.36), upperIvory);
  rearBridge.name = 'Raised aft ivory command bridge';
  rearBridge.position.set(0, 0.295, 1.08);
  group.add(rearBridge);

  const navigationBeacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.047, 0), sensorMaterial);
  navigationBeacon.position.set(0, 0.375, -1.74);
  navigationBeacon.scale.y = 0.45;
  group.add(navigationBeacon);

  group.userData.triangleCount = countMeshTriangles(group);
  group.userData.proceduralAssembly = true;
  group.userData.engineCount = engineRibbons.length;
  group.userData.opaqueForegroundHull = true;
  group.userData.silhouette = 'volumetric ivory-and-indigo swept three-dimensional exploration craft';
  group.userData.framing = 'lower-center elevated rear-three-quarter camera-relative chase';
  group.userData.layeredAftArmor = true;
  group.userData.concentricNozzleStages = 4;
  group.userData.armorFacetShading = true;
  group.userData.sculptedTaperedNacelles = true;
  group.userData.volumetricFuselage = true;
  group.userData.raisedCockpit = true;
  group.userData.ventralKeel = true;
  group.userData.sweptWingDihedral = true;
  group.userData.assetLoaded = false;
  const propulsion = {
    mode: 'cruise',
    throttle: 0.2,
    speedMetersPerSecond: 0,
    actualSpeedDriven: false,
    visualThrust: 0.2,
    plumeLength: 0.624,
    bankRadians: 0,
  };
  group.userData.propulsion = propulsion;
  let throttle = 0.2;
  let targetThrust = throttle;
  let profileMultiplier = 1;
  let physicalPlumeLengthScale = 1;

  const updatePlumes = (amount: number) => {
    propulsion.visualThrust = amount;
    const length = 0.42 + amount * 1.02 * profileMultiplier;
    propulsion.plumeLength = length;
    for (const trail of engineRibbons) {
      trail.root.scale.z = length * physicalPlumeLengthScale;
      trail.root.scale.x = 0.93 + amount * 0.23;
      trail.root.scale.y = 0.93 + amount * 0.23;
      (trail.core.material as THREE.MeshBasicMaterial).opacity = 0.5 + amount * 0.44;
      (trail.halo.material as THREE.MeshBasicMaterial).opacity = 0.15 + amount * 0.27;
    }
  };

  return {
    group,
    installAuthoredModel(model, options) {
      if (group.userData.assetLoaded || !(model instanceof THREE.Group)) return false;

      const engineSockets = [
        ['SOCKET_ENGINE_PORT', 'White-hot port ion core'],
        ['SOCKET_ENGINE_STARBOARD', 'White-hot starboard ion core'],
      ] as const;
      const fourWingNavigationSockets = [
        ['SOCKET_NAV_FORE_PORT', 'Magenta port navigation wingtip'],
        ['SOCKET_NAV_FORE_STARBOARD', 'Magenta starboard navigation wingtip'],
        ['SOCKET_NAV_AFT_PORT', 'Magenta aft port navigation wingtip'],
        ['SOCKET_NAV_AFT_STARBOARD', 'Magenta aft starboard navigation wingtip'],
      ] as const;
      const legacyNavigationSockets = [
        ['SOCKET_NAV_PORT', 'Magenta port navigation wingtip'],
        ['SOCKET_NAV_STARBOARD', 'Magenta starboard navigation wingtip'],
      ] as const;
      const usesFourActualWings = fourWingNavigationSockets.some(
        ([socketName]) => model.getObjectByName(socketName) !== undefined,
      );
      const navigationSockets = usesFourActualWings
        ? fourWingNavigationSockets
        : legacyNavigationSockets;
      const actualSockets = [...engineSockets, ...navigationSockets];
      const socketObjects = actualSockets.map(([socketName]) => model.getObjectByName(socketName));
      if (socketObjects.some((socket) => socket === undefined)) return false;

      const preservedRoots = new Set(engineRibbons.map((trail) => trail.root));
      const preservedGeometries = new Set<THREE.BufferGeometry>();
      const preservedMaterials = new Set<THREE.Material>();
      for (const root of preservedRoots) {
        root.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          preservedGeometries.add(object.geometry);
          const entries = Array.isArray(object.material) ? object.material : [object.material];
          for (const entry of entries) preservedMaterials.add(entry);
        });
      }

      const retiredGeometries = new Set<THREE.BufferGeometry>();
      const retiredMaterials = new Set<THREE.Material>();
      for (const child of [...group.children]) {
        if (child instanceof THREE.Group && preservedRoots.has(child)) continue;
        child.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          retiredGeometries.add(object.geometry);
          const entries = Array.isArray(object.material) ? object.material : [object.material];
          for (const entry of entries) retiredMaterials.add(entry);
        });
        group.remove(child);
      }

      for (const geometry of retiredGeometries) {
        if (!preservedGeometries.has(geometry)) geometry.dispose();
      }
      for (const entry of retiredMaterials) {
        if (!preservedMaterials.has(entry)) entry.dispose();
      }
      engineCores.length = 0;

      const assetName = options.assetName ?? 'AURORA VX-9 // Long-range celestial surveyor';
      model.name = `${assetName} / Authored physical spacecraft hull`;
      model.scale.setScalar(options.scale);
      group.add(model);
      group.updateMatrixWorld(true);

      for (let index = 0; index < socketObjects.length; index += 1) {
        const socket = socketObjects[index]!;
        // These are the actual GLB attachment empties, never synthetic filler.
        // attach preserves their complete scaled model-to-ship transform.
        group.attach(socket);

        if (index >= engineSockets.length) {
          const socketName = actualSockets[index]![0];
          socket.userData.physicalNavigationSocket = true;
          socket.userData.navigationSide = socketName.endsWith('_PORT') ? 'port' : 'starboard';
          socket.userData.navigationPosition = socketName.includes('_FORE_')
            ? 'fore'
            : socketName.includes('_AFT_')
              ? 'aft'
              : 'main';
          socket.userData.navigationEmission = 'magenta';
        }

        const legacyMarker = new THREE.Object3D();
        legacyMarker.name = actualSockets[index]![1];
        legacyMarker.userData.physicalSocketMarker = true;
        socket.add(legacyMarker);
      }

      for (let index = 0; index < engineRibbons.length; index += 1) {
        const root = engineRibbons[index]!.root;
        const socket = socketObjects[index]!;
        root.position.copy(socket.position);
        root.quaternion.copy(socket.quaternion);
        root.userData.authoredSocket = true;
        root.userData.authoredSocketName = actualSockets[index]![0];
        root.userData.authoredModelScale = options.scale;
        root.userData.nozzleRadius = options.nozzleRadius * options.scale;
      }

      const assetTriangles = countMeshTriangles(model);
      group.name = assetName;
      group.userData.assetLoaded = true;
      group.userData.assetId = options.assetId;
      group.userData.assetName = assetName;
      group.userData.assetUrl = options.assetUrl;
      group.userData.assetScale = options.scale;
      group.userData.assetTriangleCount = assetTriangles;
      group.userData.triangleCount = countMeshTriangles(group);
      group.userData.materialBatchCount = options.materialCount;
      group.userData.materialCount = options.materialCount;
      group.userData.opaqueMeshCount = options.opaqueMeshCount;
      group.userData.emissiveMeshCount = options.emissiveMeshCount;
      group.userData.materialRoles = [...options.materialRoles];
      group.userData.nodeMaterials = options.nodeMaterials;
      group.userData.transmissionPasses = options.transmissionPasses;
      group.userData.navigationSocketNames = navigationSockets.map(([name]) => name);
      group.userData.navigationSocketCount = navigationSockets.length;
      group.userData.navigationFixtureCount = navigationSockets.length;
      group.userData.wingCount = navigationSockets.length;
      group.userData.proceduralAssembly = false;
      delete group.userData.assetError;
      return true;
    },
    promoteToPhysicalMeters() {
      if (group.userData.physicalMetersPerGltfUnit === 1) return true;
      const authored = group.userData.assetLoaded === true;
      const sourceScale = authored ? Number(group.userData.assetScale) : 1;
      if (!Number.isFinite(sourceScale) || sourceScale <= 0) return false;
      const inverse = 1 / sourceScale;
      const plumeRoots = new Set(engineRibbons.map((trail) => trail.root));

      // The loader extracted the six real socket empties after scaling the GLB
      // for its old foreground composition. Undo that transform on the actual
      // model and sockets, rather than concealing it in another outer scale.
      for (const child of group.children) {
        child.position.multiplyScalar(inverse);
        if (!plumeRoots.has(child as THREE.Group)) child.scale.multiplyScalar(inverse);
      }
      physicalPlumeLengthScale = inverse;
      for (const trail of engineRibbons) {
        trail.core.scale.x *= inverse;
        trail.core.scale.y *= inverse;
        trail.halo.scale.x *= inverse;
        trail.halo.scale.y *= inverse;
        if (typeof trail.root.userData.nozzleRadius === 'number') {
          trail.root.userData.nozzleRadius *= inverse;
        }
        if (authored) trail.root.userData.authoredModelScale = 1;
        trail.root.userData.physicalMetersPerGltfUnit = 1;
      }
      group.position.set(0, 0, 0);
      group.quaternion.identity();
      group.scale.setScalar(1);
      group.userData.foregroundPresentationScale = sourceScale;
      group.userData.physicalMetersPerGltfUnit = 1;
      group.userData.worldSpaceExterior = true;
      group.userData.opaqueForegroundHull = false;
      group.userData.framing = 'canonical-meter world exterior with shared terrain depth';
      if (authored) group.userData.assetScale = 1;
      updatePlumes(propulsion.visualThrust);
      group.updateMatrixWorld(true);
      return true;
    },
    setThrottle(amount, mode, speedMetersPerSecond) {
      throttle = Math.max(0.1, Math.min(amount, 1));
      propulsion.mode = mode;
      propulsion.throttle = throttle;
      profileMultiplier = mode === 'pulse'
        ? 4.95
        : mode === 'boost'
          ? 2.95
          : mode === 'hyper' || mode === 'hyperdrive'
            ? 5.9
            : 1;

      if (speedMetersPerSecond === undefined || !Number.isFinite(speedMetersPerSecond)) {
        propulsion.actualSpeedDriven = false;
        targetThrust = throttle;
        updatePlumes(targetThrust);
        return;
      }

      const actualSpeed = Math.max(0, speedMetersPerSecond);
      const referenceSpeed = mode === 'boost'
        ? 160_000
        : mode === 'pulse' || mode === 'hyper' || mode === 'hyperdrive'
          ? 850_000
          : 60_000;
      const actualEnergy = 1 - Math.exp(-actualSpeed / referenceSpeed);
      propulsion.actualSpeedDriven = true;
      propulsion.speedMetersPerSecond = actualSpeed;
      targetThrust = Math.max(0.075, Math.min(1, actualEnergy * 0.82 + throttle * 0.18));
    },
    update(elapsed, bank, deltaSeconds = 1 / 60) {
      const frame = Number.isFinite(deltaSeconds)
        ? THREE.MathUtils.clamp(deltaSeconds, 0, 0.1)
        : 1 / 60;
      if (propulsion.actualSpeedDriven) {
        updatePlumes(THREE.MathUtils.damp(propulsion.visualThrust, targetThrust, 8.8, frame));
      }
      const targetBank = THREE.MathUtils.clamp(bank, -1, 1) * -0.43;
      if (group.userData.worldSpaceExterior !== true) {
        group.rotation.z = THREE.MathUtils.damp(group.rotation.z, targetBank, 6.05, frame);
        propulsion.bankRadians = group.rotation.z;
      }
      for (const core of engineCores) {
        core.scale.setScalar(
          0.94 + Math.sin(elapsed * 9.5) * (0.026 + propulsion.visualThrust * 0.014) +
            propulsion.visualThrust * 0.16,
        );
      }
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const authoredTextures = new Set<THREE.Texture>();
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        const entries = Array.isArray(object.material) ? object.material : [object.material];
        for (const entry of entries) {
          materials.add(entry);
          if (entry.userData.authoredAuroraMaterial !== true) continue;
          const surface = entry as THREE.MeshStandardMaterial;
          for (const texture of [
            surface.map,
            surface.roughnessMap,
            surface.metalnessMap,
            surface.normalMap,
          ]) {
            if (texture instanceof THREE.Texture) authoredTextures.add(texture);
          }
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const entry of materials) entry.dispose();
      for (const texture of authoredTextures) texture.dispose();
    },
  };
}

function countMeshTriangles(group: THREE.Group): number {
  let triangles = 0;
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    triangles += geometry.index ? geometry.index.count / 3 : (geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  return triangles;
}
