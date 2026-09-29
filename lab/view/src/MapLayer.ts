import * as THREE from 'three/webgpu';
import {
  findApsides, osculatingOrbit, PathCache, sub,
  type CelestialBody, type Ephemeris, type Trajectory, type Vec3,
} from './orbitCore';
import { ellipsePoints } from './ConicPath';

export type Focus = { kind: 'vessel' } | { kind: 'body'; index: number };

const ORBIT_POINTS = 256;
/** Bodies' osculating orbits are recomputed this often (wall time). */
const ORBIT_REFRESH_MS = 500;
const APSIS_REFRESH_MS = 250;
const LABEL_HEIGHT = 13;
const PATH_COLOR = '#4fc8ff';

/** Ecliptic (x, y, z), z up, to three.js (x, z, -y), y up: a proper rotation. */
export function toThree(v: Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.z, -v.y);
}

/** The vessel's coast, as barycentric inertial samples, drawn relative to a reference body. */
export interface VesselPath {
  trajectory: Trajectory;
  /** Changes whenever the trajectory is replaced or restarted. */
  generation: number;
  reference: number;
}

/** One frame of map state, all barycentric at `time`. */
export interface MapFrame {
  time: number;
  bodyPositions: Float64Array;
  bodyVelocities: Float64Array;
  /** Render origin (the focus). */
  origin: Vec3;
  vessel: Vec3;
  vesselVelocity: Vec3;
  path: VesselPath | null;
  planPath?: VesselPath | null;
  /** 0 hides the map, 1 shows it fully. */
  mapWeight: number;
  focus: Focus;
  camera: THREE.Camera;
  width: number;
  height: number;
}

interface BodyView {
  body: CelestialBody;
  sphere: THREE.Mesh | null;
  orbit: THREE.LineLoop | null;
  marker: HTMLDivElement;
}

/**
 * The map: bodies as spheres (except those drawn by the caller, such as a
 * terrain planet), their osculating orbits about their parents, the vessel's
 * coast path with its apsides, and clickable labels. Lines and labels are
 * drawn at the map weight's opacity; spheres are always drawn.
 */
export class MapLayer {
  private readonly bodies: readonly CelestialBody[];
  private readonly ephemeris: Ephemeris;
  private readonly views: BodyView[];
  private readonly lineMaterials: THREE.LineBasicMaterial[] = [];
  private readonly vesselMarker: HTMLDivElement;
  private readonly pathGeometry = new THREE.BufferGeometry();
  private readonly pathLine: THREE.Line;
  private readonly planGeometry = new THREE.BufferGeometry();
  private readonly planLine: THREE.Line;
  private planCache: PathCache | null = null;
  private planGeneration = -1;
  private planReference = -1;
  private pathCache: PathCache | null = null;
  private pathGeneration = -1;
  private pathReference = -1;
  private readonly apsisMarkers: HTMLDivElement[];
  private apsides: { label: string; relative: Vec3 }[] = [];
  private lastOrbitRefresh = -Infinity;
  private lastApsides = -Infinity;
  private readonly projected = new THREE.Vector3();

  /** drawnElsewhere: bodies the caller draws itself (no sphere here). */
  constructor(scene: THREE.Scene, private readonly overlay: HTMLElement, ephemeris: Ephemeris, drawnElsewhere: readonly number[],
    onPick: (focus: Focus) => void) {
    this.ephemeris = ephemeris;
    this.bodies = ephemeris.bodies;
    this.views = this.bodies.map((body) => {
      const isStar = body.parentIndex === null;
      let sphere: THREE.Mesh | null = null;
      if (!drawnElsewhere.includes(body.index)) {
        sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), isStar
          ? new THREE.MeshBasicMaterial({ color: body.color })
          : new THREE.MeshStandardMaterial({ color: body.color, roughness: 0.9, metalness: 0 }));
        sphere.scale.setScalar(body.radiusMeters);
        scene.add(sphere);
      }
      let orbit: THREE.LineLoop | null = null;
      if (body.parentIndex !== null) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_POINTS * 3), 3));
        orbit = new THREE.LineLoop(geometry, this.lineMaterial(body.color));
        orbit.frustumCulled = false;
        orbit.renderOrder = 10;
        scene.add(orbit);
      }
      const marker = this.createMarker(body.name, body.color, isStar ? 'star' : 'body');
      marker.addEventListener('click', () => onPick({ kind: 'body', index: body.index }));
      return { body, sphere, orbit, marker };
    });
    this.vesselMarker = this.createMarker('Vessel', '#7dffb0', 'vessel');
    this.vesselMarker.addEventListener('click', () => onPick({ kind: 'vessel' }));
    this.pathGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(1024 * 3), 3));
    this.pathLine = new THREE.Line(this.pathGeometry, this.lineMaterial(PATH_COLOR));
    this.pathLine.frustumCulled = false;
    this.pathLine.renderOrder = 11;
    scene.add(this.pathLine);
    this.planGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(1024 * 3), 3));
    this.planLine = new THREE.Line(this.planGeometry, this.lineMaterial('#ffca66'));
    this.planLine.frustumCulled = false;
    this.planLine.renderOrder = 12;
    scene.add(this.planLine);
    this.apsisMarkers = [0, 1].map(() => this.createMarker('', PATH_COLOR, 'event'));
  }

  /** The star, whose direction lights the scene. */
  get starIndex(): number {
    const star = this.bodies.find((b) => b.parentIndex === null);
    if (!star) throw new Error('MapLayer: system has no root body');
    return star.index;
  }

  update(frame: MapFrame): void {
    const position = (i: number): Vec3 => ({ x: frame.bodyPositions[i * 3]!, y: frame.bodyPositions[i * 3 + 1]!, z: frame.bodyPositions[i * 3 + 2]! });
    const velocity = (i: number): Vec3 => ({ x: frame.bodyVelocities[i * 3]!, y: frame.bodyVelocities[i * 3 + 1]!, z: frame.bodyVelocities[i * 3 + 2]! });
    for (const view of this.views) if (view.sphere) toThree(sub(position(view.body.index), frame.origin), view.sphere.position);
    this.updateOrbits(frame.origin, position, velocity);
    this.updatePath(frame, position, velocity);
    this.updatePlanPath(frame, position, velocity);
    for (const material of this.lineMaterials) material.opacity = frame.mapWeight;
    for (const view of this.views) if (view.orbit) view.orbit.visible = frame.mapWeight > 0;
    this.pathLine.visible &&= frame.mapWeight > 0;
    this.planLine.visible &&= frame.mapWeight > 0;
    this.placeMarkers(frame, position);
  }

  private lineMaterial(color: string): THREE.LineBasicMaterial {
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
    this.lineMaterials.push(material);
    return material;
  }

  private createMarker(name: string, color: string, kind: string): HTMLDivElement {
    const marker = document.createElement('div');
    marker.className = `marker ${kind}`;
    marker.innerHTML = `<i style="background:${color}"></i><span></span>`;
    marker.querySelector('span')!.textContent = name;
    this.overlay.append(marker);
    return marker;
  }

  private updateOrbits(origin: Vec3, position: (i: number) => Vec3, velocity: (i: number) => Vec3): void {
    const now = performance.now();
    const reshape = now - this.lastOrbitRefresh >= ORBIT_REFRESH_MS;
    if (reshape) this.lastOrbitRefresh = now;
    for (const view of this.views) {
      const orbit = view.orbit;
      if (!orbit) continue;
      const parent = view.body.parentIndex!;
      if (reshape) {
        const points = ellipsePoints(sub(position(view.body.index), position(parent)), sub(velocity(view.body.index), velocity(parent)),
          this.bodies[parent]!.gm + view.body.gm, ORBIT_POINTS);
        const attribute = orbit.geometry.getAttribute('position') as THREE.BufferAttribute;
        const a = attribute.array as Float32Array;
        for (let i = 0; i < ORBIT_POINTS; i += 1) { a[i * 3] = points[i * 3]!; a[i * 3 + 1] = points[i * 3 + 2]!; a[i * 3 + 2] = -points[i * 3 + 1]!; }
        attribute.needsUpdate = true;
      }
      // Points are relative to the parent; float64 subtraction keeps the offset from the origin exact.
      toThree(sub(position(parent), origin), orbit.position);
    }
  }

  private updatePath(frame: MapFrame, position: (i: number) => Vec3, velocity: (i: number) => Vec3): void {
    const path = frame.path;
    if (!path || path.trajectory.count < 2 || path.trajectory.lastTime <= frame.time) {
      this.pathLine.visible = false;
      this.apsides = [];
      return;
    }
    const trajectory = path.trajectory;
    const reference = path.reference;
    const referenceNow = position(reference);
    if (!this.pathCache || this.pathGeneration !== path.generation || this.pathReference !== reference) {
      this.pathGeneration = path.generation;
      this.pathReference = reference;
      const osc = osculatingOrbit(sub(frame.vessel, referenceNow), sub(frame.vesselVelocity, velocity(reference)), this.bodies[reference]!.gm);
      const span = trajectory.lastTime - trajectory.firstTime;
      const natural = Number.isFinite(osc.periodSeconds) ? osc.periodSeconds : span;
      this.pathCache = new PathCache(Math.max(natural / 256, span / 6000));
      this.lastApsides = -Infinity;
    }
    // Samples relative to the reference body at their own time: the path in its non-rotating frame.
    this.pathCache.update(Math.max(frame.time, trajectory.firstTime), trajectory.lastTime,
      (t) => sub(trajectory.sample(t).position, this.ephemeris.bodyPosition(reference, t)));
    let attribute = this.pathGeometry.getAttribute('position') as THREE.BufferAttribute;
    if (attribute.count < this.pathCache.count + 1) {
      attribute = new THREE.BufferAttribute(new Float32Array((this.pathCache.count + 1) * 2 * 3), 3);
      this.pathGeometry.setAttribute('position', attribute);
    }
    const written = this.pathCache.writeRelative(attribute.array as Float32Array, sub(frame.origin, referenceNow), sub(frame.vessel, referenceNow), null, 1);
    attribute.needsUpdate = true;
    this.pathGeometry.setDrawRange(0, written);
    this.pathLine.visible = true;
    const now = performance.now();
    if (now - this.lastApsides >= APSIS_REFRESH_MS) {
      this.lastApsides = now;
      const body = this.bodies[reference]!;
      this.apsides = findApsides(trajectory, this.ephemeris, reference, frame.time, 2).map((apsis) => ({
        label: `${apsis.kind === 'periapsis' ? 'Pe' : 'Ap'} ${((apsis.distanceMeters - body.radiusMeters) / 1000).toFixed(1)} km`,
        relative: sub(apsis.position, this.ephemeris.bodyPosition(reference, apsis.time)),
      }));
    }
  }

  private updatePlanPath(frame: MapFrame, position: (i: number) => Vec3, velocity: (i: number) => Vec3): void {
    const path = frame.planPath;
    if (!path || path.trajectory.count < 2 || path.trajectory.lastTime <= frame.time) {
      this.planLine.visible = false;
      return;
    }
    const trajectory = path.trajectory;
    const reference = path.reference;
    const referenceNow = position(reference);
    if (!this.planCache || this.planGeneration !== path.generation || this.planReference !== reference) {
      this.planGeneration = path.generation;
      this.planReference = reference;
      const osc = osculatingOrbit(sub(frame.vessel, referenceNow), sub(frame.vesselVelocity, velocity(reference)), this.bodies[reference]!.gm);
      const span = trajectory.lastTime - trajectory.firstTime;
      const natural = Number.isFinite(osc.periodSeconds) ? osc.periodSeconds : span;
      this.planCache = new PathCache(Math.max(natural / 256, span / 6000));
    }
    this.planCache.update(Math.max(frame.time, trajectory.firstTime), trajectory.lastTime,
      (t) => sub(trajectory.sample(t).position, this.ephemeris.bodyPosition(reference, t)));
    let attribute = this.planGeometry.getAttribute('position') as THREE.BufferAttribute;
    if (attribute.count < this.planCache.count + 1) {
      attribute = new THREE.BufferAttribute(new Float32Array((this.planCache.count + 1) * 2 * 3), 3);
      this.planGeometry.setAttribute('position', attribute);
    }
    const written = this.planCache.writeRelative(attribute.array as Float32Array, sub(frame.origin, referenceNow), sub(frame.vessel, referenceNow), null, 1);
    attribute.needsUpdate = true;
    this.planGeometry.setDrawRange(0, written);
    this.planLine.visible = frame.mapWeight > 0;
  }

  private placeMarker(marker: HTMLDivElement, relative: Vec3, frame: MapFrame): { x: number; y: number } | null {
    toThree(relative, this.projected).project(frame.camera);
    const p = this.projected;
    const visible = frame.mapWeight > 0 && p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2;
    marker.style.display = visible ? 'flex' : 'none';
    if (!visible) return null;
    const x = (p.x * 0.5 + 0.5) * frame.width;
    const y = (-p.y * 0.5 + 0.5) * frame.height;
    marker.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    marker.style.opacity = String(frame.mapWeight);
    // Half-faded labels are not yet clickable, so a drag in the flight view never lands on one.
    marker.style.pointerEvents = frame.mapWeight > 0.5 ? 'auto' : 'none';
    return { x, y };
  }

  private placeMarkers(frame: MapFrame, position: (i: number) => Vec3): void {
    const focus = frame.focus;
    const entries: { marker: HTMLDivElement; relative: Vec3; priority: number }[] = this.views.map((view) => ({
      marker: view.marker, relative: sub(position(view.body.index), frame.origin),
      priority: (focus.kind === 'body' && focus.index === view.body.index ? 1e60 : 0) + view.body.massKg,
    }));
    entries.push({ marker: this.vesselMarker, relative: sub(frame.vessel, frame.origin), priority: focus.kind === 'vessel' ? 1e60 : 1e50 });
    const referenceNow = frame.path ? sub(position(frame.path.reference), frame.origin) : null;
    this.apsisMarkers.forEach((marker, i) => {
      const apsis = this.apsides[i];
      if (!apsis || !referenceNow || !this.pathLine.visible) { marker.style.display = 'none'; return; }
      marker.querySelector('span')!.textContent = apsis.label;
      entries.push({ marker, relative: { x: referenceNow.x + apsis.relative.x, y: referenceNow.y + apsis.relative.y, z: referenceNow.z + apsis.relative.z }, priority: 1e49 - i });
    });
    entries.sort((a, b) => b.priority - a.priority);
    // A label overlapping a higher-priority one keeps only its dot.
    const shown: { x: number; y: number; w: number }[] = [];
    for (const entry of entries) {
      const at = this.placeMarker(entry.marker, entry.relative, frame);
      if (!at) continue;
      entry.marker.classList.remove('crowded');
      const w = entry.marker.offsetWidth;
      const crowded = shown.some((p) => Math.abs(p.y - at.y) < LABEL_HEIGHT && (at.x >= p.x ? at.x - p.x < p.w : p.x - at.x < w));
      entry.marker.classList.toggle('crowded', crowded);
      if (!crowded) shown.push({ ...at, w });
    }
  }
}
