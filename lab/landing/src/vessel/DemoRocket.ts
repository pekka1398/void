import type { BodyShape } from '../physics/ContactWorld';
import { levelForTileSize } from '../terrain/TerrainTiles';
import type { Terrain } from '../terrain/Surface';
import type { Vec3 } from '../orbitCore';
import type { LanderOptions, LanderSpec } from './Lander';

type Piece = Extract<BodyShape, { kind: 'compound' }>['parts'][number];

/** The two-stage lab rocket: collider shapes, masses, engines, and the contact options sized to its planet. */
export interface DemoRocket {
  /** The stack before separation (aggregate of both parts, booster engine). */
  full: LanderSpec;
  upper: LanderSpec;
  booster: LanderSpec;
  upperShape: BodyShape;
  boosterShape: BodyShape;
  options: LanderOptions;
  /** Body-fixed direction of the launch site. */
  launchSite: Vec3;
}

const UPPER_PIECES: Piece[] = [
  { shape: { kind: 'cylinder', radius: 1.05, halfHeight: 0.875 }, position: { x: 0, y: 0.175, z: 0 } },
  { shape: { kind: 'cone', radius: 0.9, halfHeight: 0.5 }, position: { x: 0, y: 1.55, z: 0 } },
  { shape: { kind: 'cone', radius: 0.43, halfHeight: 0.185 }, position: { x: 0, y: -0.86, z: 0 } },
];

/** Booster body and engine plus four splayed legs, each a strut ending in a foot pad. */
function boosterPieces(): Piece[] {
  const pieces: Piece[] = [
    { shape: { kind: 'cylinder', radius: 1.25, halfHeight: 1.175 }, position: { x: 0, y: 0.175, z: 0 } },
    { shape: { kind: 'cone', radius: 0.58, halfHeight: 0.185 }, position: { x: 0, y: -1.21, z: 0 } },
  ];
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    const root = { x: x * 0.72, y: 0.05, z: z * 0.72 };
    const foot = { x: x * 1.28, y: -1.37, z: z * 1.28 };
    const span = { x: foot.x - root.x, y: foot.y - root.y, z: foot.z - root.z };
    const length = Math.hypot(span.x, span.y, span.z);
    const d = { x: span.x / length, y: span.y / length, z: span.z / length };
    // Shortest rotation from +y to the strut direction: axis y x d, half-angle quaternion.
    const w = Math.sqrt((1 + d.y) / 2);
    const rotation = { x: d.z / (2 * w), y: 0, z: -d.x / (2 * w), w };
    pieces.push({ shape: { kind: 'cylinder', radius: 0.1, halfHeight: length / 2 },
      position: { x: (root.x + foot.x) / 2, y: (root.y + foot.y) / 2, z: (root.z + foot.z) / 2 }, rotation });
    pieces.push({ shape: { kind: 'box', halfExtents: { x: 0.21, y: 0.05, z: 0.21 } }, position: foot });
  }
  return pieces;
}

export function demoRocket(terrain: Terrain): DemoRocket {
  const upperShape: BodyShape = { kind: 'compound', parts: UPPER_PIECES };
  const boosterShape: BodyShape = { kind: 'compound', parts: boosterPieces() };
  // Sized to reach low orbit on an Earth-size planet with no atmosphere, KSP-style (light tanks, strong engines):
  // booster 120 kN, Isp 310 s, liftoff thrust-to-weight about 2 at 9.8 m/s^2, 3.4 km/s;
  // upper 20 kN, Isp 340 s, thrust-to-weight about 1.5, 5.1 km/s; 8.6 km/s in all.
  const full: LanderSpec = { thrustNewtons: 120_000, specificImpulseSeconds: 310, dryMassKg: 1900, fuelMassKg: 4000,
    // Reference point is the attached parts' centre of mass; feet are about 2 m below it.
    halfExtents: { x: 1.5, y: 2.05, z: 1.5 }, friction: 0.8 };
  const upper: LanderSpec = { thrustNewtons: 20_000, specificImpulseSeconds: 340, dryMassKg: 300, fuelMassKg: 1100,
    halfExtents: { x: 1.05, y: 1.15, z: 1.05 }, contactShape: upperShape, friction: 0.8, crashToleranceMetersPerSecond: 10 };
  const booster: LanderSpec = { thrustNewtons: full.thrustNewtons, specificImpulseSeconds: full.specificImpulseSeconds,
    dryMassKg: 500, fuelMassKg: 4000, halfExtents: { x: 1.5, y: 1.42, z: 1.5 }, contactShape: boosterShape, friction: 0.8, crashToleranceMetersPerSecond: 10 };
  const options: LanderOptions = { contact: { stepSeconds: 1 / 60, tileLevel: levelForTileSize(terrain.radiusMeters, 300), tileResolution: 33,
    tileReachMeters: 300, tileKeepMeters: 600, recenterMeters: 1000 }, tolerances: { positionMeters: 1e-6, velocityMetersPerSecond: 1e-9 },
    bandEnterMeters: 200, bandExitMeters: 400 };
  return { full, upper, booster, upperShape, boosterShape, options, launchSite: { x: 0.8, y: 0.55, z: 0.25 } };
}
