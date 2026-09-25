import type { CelestialBody } from './SystemSpec';
import type { Vec3 } from './Vec3';

/**
 * The body whose Laplace sphere of influence most deeply contains a point,
 * walking down the body tree from the root. In an N-body world this is only a
 * choice of reference for osculating elements and display, never a dynamics switch.
 */
export class DominanceTree {
  private readonly bodies: readonly CelestialBody[];
  private readonly children: number[][];
  private readonly root: number;

  constructor(bodies: readonly CelestialBody[]) {
    this.bodies = bodies;
    this.children = bodies.map(() => []);
    const roots = bodies.filter((b) => b.parentIndex === null);
    if (roots.length !== 1) throw new Error(`DominanceTree: expected one root, found ${roots.length}`);
    this.root = roots[0]!.index;
    for (const b of bodies) if (b.parentIndex !== null) this.children[b.parentIndex]!.push(b.index);
  }

  /** positions: barycentric body positions at the same instant as point. */
  dominant(positions: Float64Array, point: Vec3): number {
    let current = this.root;
    for (;;) {
      let best: number | null = null;
      let bestRatio = 1;
      for (const child of this.children[current]!) {
        const soi = this.bodies[child]!.sphereOfInfluenceMeters;
        if (soi === null) throw new Error(`DominanceTree: ${this.bodies[child]!.id} has no sphere of influence`);
        const d = Math.hypot(
          point.x - positions[child * 3]!, point.y - positions[child * 3 + 1]!, point.z - positions[child * 3 + 2]!,
        );
        const ratio = d / soi;
        if (ratio < bestRatio) { bestRatio = ratio; best = child; }
      }
      if (best === null) return current;
      current = best;
    }
  }
}
