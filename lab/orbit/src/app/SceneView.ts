import * as THREE from 'three';
import {
  bodyOrientation, directionToFrame, FrameEvaluator, osculatingOrbit, sub, toFrame,
  type CelestialBody, type FrameSpec, type FrameState, type Simulation, type Vec3,
} from '../orbit';
import { PathCache } from './PathCache';

/** Render units are kilometres, relative to the focused object. */
export const RENDER_SCALE = 1e-3;
const TRAIL_SAMPLES_PER_PERIOD = 128;
const MAX_TRAIL_SAMPLES = 6000;
const LABEL_HEIGHT = 13;

export type Focus = { kind: 'body'; index: number } | { kind: 'vessel' };

interface BodyView {
  body: CelestialBody;
  group: THREE.Group;
  light: THREE.PointLight | null;
  trail: THREE.Line;
  cache: PathCache | null;
  marker: HTMLDivElement;
}

export class SceneView {
  readonly scene = new THREE.Scene();
  private readonly sim: Simulation;
  private readonly overlay: HTMLElement;
  private readonly bodies: BodyView[];
  private readonly vesselTrail: THREE.Line;
  private readonly vesselMarker: HTMLDivElement;
  private vesselCache: PathCache | null = null;
  private frame: FrameEvaluator;
  private trailSpan: number;
  private vesselSpan: number;
  private readonly projected = new THREE.Vector3();

  constructor(sim: Simulation, overlay: HTMLElement, frame: FrameSpec, trailSpan: number, vesselSpan: number, onPick: (focus: Focus) => void) {
    this.sim = sim;
    this.overlay = overlay;
    this.frame = new FrameEvaluator(sim.ephemeris, frame);
    this.trailSpan = trailSpan;
    this.vesselSpan = vesselSpan;
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.08));
    this.bodies = sim.system.bodies.map((body) => this.createBody(body, onPick));
    this.vesselTrail = createLine('#7dffb0', 1);
    this.scene.add(this.vesselTrail);
    this.vesselMarker = createMarker(overlay, 'Vessel', '#7dffb0', 'vessel');
    this.vesselMarker.addEventListener('click', () => onPick({ kind: 'vessel' }));
  }

  get frameEvaluator(): FrameEvaluator {
    return this.frame;
  }

  setFrame(spec: FrameSpec): void {
    this.frame = new FrameEvaluator(this.sim.ephemeris, spec);
    this.invalidatePaths();
  }

  setTrailSpan(seconds: number): void {
    this.trailSpan = seconds;
    this.invalidatePaths();
  }

  setVesselSpan(seconds: number): void {
    this.vesselSpan = seconds;
    this.invalidatePaths();
  }

  invalidatePaths(): void {
    for (const view of this.bodies) view.cache = null;
    this.vesselCache = null;
  }

  /** Frame-coordinate position of the focus at the current time. */
  focusPosition(focus: Focus, frameNow: FrameState): Vec3 {
    if (focus.kind === 'vessel') return toFrame(frameNow, this.sim.vesselPositionAt(this.sim.time));
    return toFrame(frameNow, this.frame.position(focus.index));
  }

  update(focus: Focus, camera: THREE.Camera, width: number, height: number): void {
    const now = this.sim.time;
    this.updateTrailCaches(now);
    this.updateVesselCache(now);

    const frameNow = this.frame.evaluate(now);
    const origin = this.focusPosition(focus, frameNow);
    const bodyFrame: Vec3[] = this.bodies.map((view) => toFrame(frameNow, this.frame.position(view.body.index)));
    const vesselFrame = toFrame(frameNow, this.sim.vesselPositionAt(now));

    for (const view of this.bodies) {
      const p = bodyFrame[view.body.index]!;
      setRenderPosition(view.group.position, sub(p, origin));
      const axes = bodyOrientation(view.body, now);
      // Sphere local axes: X = prime meridian, Y = spin axis, Z = X cross Y = -(body y).
      const bx = toThree(directionToFrame(frameNow, axes.x));
      const by = toThree(directionToFrame(frameNow, axes.z));
      const bz = toThree(directionToFrame(frameNow, axes.y)).negate();
      view.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bx, by, bz));
      const centredHere = (this.frame.spec.kind === 'body-inertial' || this.frame.spec.kind === 'body-surface')
        && this.frame.spec.body === view.body.index;
      view.trail.visible = view.cache !== null && !centredHere;
      if (view.trail.visible && view.cache) writeLine(view.trail, view.cache, origin, p);
    }

    const vesselVisible = this.vesselCache !== null;
    this.vesselTrail.visible = vesselVisible;
    if (this.vesselCache) writeLine(this.vesselTrail, this.vesselCache, origin, vesselFrame);
    this.vesselMarker.classList.toggle('crashed', this.sim.impact !== null);
    this.vesselMarker.querySelector('span')!.textContent = this.sim.impact ? 'Vessel ✕ impact' : 'Vessel';

    // A label overlapping a higher-priority one keeps only its dot:
    // focus first, then the vessel, then bodies by mass.
    const entries: { marker: HTMLDivElement; relative: Vec3; priority: number }[] = this.bodies.map((view) => ({
      marker: view.marker,
      relative: sub(bodyFrame[view.body.index]!, origin),
      priority: (focus.kind === 'body' && focus.index === view.body.index ? 1e60 : 0) + view.body.massKg,
    }));
    entries.push({ marker: this.vesselMarker, relative: sub(vesselFrame, origin), priority: focus.kind === 'vessel' ? 1e60 : 1e50 });
    entries.sort((a, b) => b.priority - a.priority);
    const shown: { x: number; y: number; w: number }[] = [];
    for (const entry of entries) {
      const at = this.placeMarker(entry.marker, entry.relative, camera, width, height);
      if (!at) continue;
      entry.marker.classList.remove('crowded');
      const w = entry.marker.offsetWidth;
      // Labels extend to the right of their dot: boxes [x, x + w] x [y - h/2, y + h/2].
      const crowded = shown.some((p) => Math.abs(p.y - at.y) < LABEL_HEIGHT
        && (at.x >= p.x ? at.x - p.x < p.w : p.x - at.x < w));
      entry.marker.classList.toggle('crowded', crowded);
      if (!crowded) shown.push({ ...at, w });
    }
  }

  private updateTrailCaches(now: number): void {
    const framePeriod = this.frame.rotationPeriodSeconds(now);
    for (const view of this.bodies) {
      const period = view.body.orbitPeriodSeconds;
      const span = Math.min(this.trailSpan, period ?? this.trailSpan, now - this.sim.ephemeris.startTime);
      if (!view.cache) {
        const natural = Math.min((period ?? this.trailSpan) / TRAIL_SAMPLES_PER_PERIOD, framePeriod / TRAIL_SAMPLES_PER_PERIOD);
        view.cache = new PathCache(Math.max(natural, this.trailSpan / MAX_TRAIL_SAMPLES));
      }
      const index = view.body.index;
      view.cache.update(now, span, (t) => toFrame(this.frame.evaluate(t), this.frame.position(index)));
    }
  }

  private updateVesselCache(now: number): void {
    const available = now - this.sim.history.firstTime;
    const span = Math.min(this.vesselSpan, available);
    if (!this.vesselCache) {
      const framePeriod = this.frame.rotationPeriodSeconds(now);
      this.vesselCache = new PathCache(Math.max(
        Math.min(this.vesselNaturalPeriod(now) / TRAIL_SAMPLES_PER_PERIOD, framePeriod / TRAIL_SAMPLES_PER_PERIOD),
        this.vesselSpan / MAX_TRAIL_SAMPLES,
      ));
    }
    this.vesselCache.update(now, span, (t) => {
      const frame = this.frame.evaluate(t);
      return toFrame(frame, this.sim.vesselPositionAt(t));
    });
  }

  /** Osculating period about the dominant body, or the time to cross its distance when unbound. */
  private vesselNaturalPeriod(now: number): number {
    const positions = new Float64Array(this.sim.ephemeris.bodyCount * 3);
    const velocities = new Float64Array(this.sim.ephemeris.bodyCount * 3);
    this.sim.ephemeris.statesAt(now, positions, velocities);
    const vessel = this.sim.vessel;
    const dominant = this.sim.dominance.dominant(positions, vessel.position);
    const body = this.sim.system.bodies[dominant]!;
    const center = { x: positions[dominant * 3]!, y: positions[dominant * 3 + 1]!, z: positions[dominant * 3 + 2]! };
    const centerVelocity = { x: velocities[dominant * 3]!, y: velocities[dominant * 3 + 1]!, z: velocities[dominant * 3 + 2]! };
    const r = sub(vessel.position, center);
    const v = sub(vessel.velocity, centerVelocity);
    const osc = osculatingOrbit(r, v, body.gm);
    if (Number.isFinite(osc.periodSeconds)) return osc.periodSeconds;
    return Math.hypot(r.x, r.y, r.z) / Math.hypot(v.x, v.y, v.z);
  }

  private createBody(body: CelestialBody, onPick: (focus: Focus) => void): BodyView {
    const isStar = body.parentIndex === null || body.massKg > 1e29;
    const group = new THREE.Group();
    const material = isStar
      ? new THREE.MeshBasicMaterial({ color: body.color })
      : new THREE.MeshStandardMaterial({ color: body.color, roughness: 0.9, metalness: 0 });
    group.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material));
    group.add(referenceLines(isStar ? '#fff4d0' : '#ffffff'));
    group.scale.setScalar(body.radiusMeters * RENDER_SCALE);
    this.scene.add(group);
    let light: THREE.PointLight | null = null;
    if (isStar) {
      // Mostly white so planet colours stay recognisable; decay 0 because distances span AU.
      light = new THREE.PointLight(new THREE.Color(body.color).lerp(new THREE.Color('#ffffff'), 0.75), 2.2, 0, 0);
      group.add(light);
    }
    const trail = createLine(body.color, 0.55);
    this.scene.add(trail);
    const marker = createMarker(this.overlay, body.name, body.color, isStar ? 'star' : 'body');
    marker.addEventListener('click', () => onPick({ kind: 'body', index: body.index }));
    return { body, group, light, trail, cache: null, marker };
  }

  private placeMarker(marker: HTMLDivElement, relative: Vec3, camera: THREE.Camera, width: number, height: number): { x: number; y: number } | null {
    this.projected.set(relative.x * RENDER_SCALE, relative.z * RENDER_SCALE, -relative.y * RENDER_SCALE).project(camera);
    const visible = this.projected.z > -1 && this.projected.z < 1
      && Math.abs(this.projected.x) < 1.2 && Math.abs(this.projected.y) < 1.2;
    marker.style.display = visible ? 'flex' : 'none';
    if (!visible) return null;
    const x = (this.projected.x * 0.5 + 0.5) * width;
    const y = (-this.projected.y * 0.5 + 0.5) * height;
    marker.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    return { x, y };
  }
}

function toThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

function setRenderPosition(target: THREE.Vector3, relative: Vec3): void {
  target.set(relative.x * RENDER_SCALE, relative.z * RENDER_SCALE, -relative.y * RENDER_SCALE);
}

function createLine(color: string, opacity: number): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  const capacity = 1024;
  const attribute = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  line.frustumCulled = false;
  return line;
}

function writeLine(line: THREE.Line, cache: PathCache, origin: Vec3, live: Vec3): void {
  const needed = cache.count + 1;
  let attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  if (attribute.count < needed) {
    attribute = new THREE.BufferAttribute(new Float32Array(Math.max(needed, attribute.count * 2) * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    line.geometry.setAttribute('position', attribute);
  }
  const written = cache.writeRelative(attribute.array as Float32Array, origin, live, RENDER_SCALE);
  attribute.needsUpdate = true;
  line.geometry.setDrawRange(0, written);
}

/** Equator and prime meridian in the sphere's local axes (Y = spin axis, X = prime meridian). */
function referenceLines(color: string): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 });
  const equator: number[] = [];
  const meridian: number[] = [];
  const r = 1.003;
  for (let i = 0; i <= 128; i += 1) {
    const a = (i / 128) * Math.PI * 2;
    equator.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    const b = -Math.PI / 2 + (i / 128) * Math.PI;
    meridian.push(Math.cos(b) * r, Math.sin(b) * r, 0);
  }
  const eq = new THREE.BufferGeometry();
  eq.setAttribute('position', new THREE.Float32BufferAttribute(equator, 3));
  const me = new THREE.BufferGeometry();
  me.setAttribute('position', new THREE.Float32BufferAttribute(meridian, 3));
  group.add(new THREE.Line(eq, material), new THREE.Line(me, material));
  return group;
}

function createMarker(overlay: HTMLElement, name: string, color: string, kind: string): HTMLDivElement {
  const marker = document.createElement('div');
  marker.className = `marker ${kind}`;
  marker.innerHTML = `<i style="background:${color}"></i><span></span>`;
  marker.querySelector('span')!.textContent = name;
  overlay.append(marker);
  return marker;
}

