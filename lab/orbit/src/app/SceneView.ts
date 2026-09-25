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
const VESSEL_COLOR = '#7dffb0';
const HISTORY_COLOR = '#ff5a5a';
const PREDICTION_COLOR = '#4fc8ff';
/** Lightness at the far end of a fading vessel path, as a fraction of the base colour. */
const FADE_FLOOR = 0.12;

export type Focus = { kind: 'body'; index: number } | { kind: 'vessel' };

/** A labelled point on a trajectory, drawn where the vessel will be at that time. */
export interface TrajectoryEvent {
  kind: 'periapsis' | 'apoapsis' | 'impact';
  time: number;
  /** Barycentric position at time. */
  position: Vec3;
  label: string;
}

interface BodyView {
  body: CelestialBody;
  group: THREE.Group;
  trail: THREE.Line;
  cache: PathCache | null;
  marker: HTMLDivElement;
}

interface MarkerEntry { marker: HTMLDivElement; relative: Vec3; priority: number }

export class SceneView {
  readonly scene = new THREE.Scene();
  private readonly sim: Simulation;
  private readonly overlay: HTMLElement;
  private readonly bodies: BodyView[];
  private readonly vesselTrail: THREE.Line;
  private readonly predictionLine: THREE.Line;
  private readonly thrustArrow: THREE.Line;
  private readonly vesselMarker: HTMLDivElement;
  private readonly eventMarkers: HTMLDivElement[] = [];
  private events: TrajectoryEvent[] = [];
  private vesselCache: PathCache | null = null;
  private predictionCache: PathCache | null = null;
  private predictionGeneration = -1;
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
    this.vesselTrail = createFadingLine();
    this.predictionLine = createFadingLine();
    this.thrustArrow = createLine('#ff9a3c', 1);
    this.scene.add(this.vesselTrail, this.predictionLine, this.thrustArrow);
    this.vesselMarker = createMarker(overlay, 'Vessel', VESSEL_COLOR, 'vessel');
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

  setEvents(events: TrajectoryEvent[]): void {
    this.events = events;
  }

  invalidatePaths(): void {
    for (const view of this.bodies) view.cache = null;
    this.vesselCache = null;
    this.predictionCache = null;
  }

  /** Frame-coordinate position of the focus at the current time. */
  focusPosition(focus: Focus, frameNow: FrameState): Vec3 {
    if (focus.kind === 'vessel') return toFrame(frameNow, this.sim.vesselPositionAt(this.sim.time));
    return toFrame(frameNow, this.frame.position(focus.index));
  }

  /** arrowLength: thrust arrow length in render units. */
  update(focus: Focus, camera: THREE.Camera, width: number, height: number, arrowLength: number): void {
    const now = this.sim.time;
    this.updateTrailCaches(now);
    this.updateVesselCache(now);
    this.updatePredictionCache(now);
    const predictionEnd = this.predictionEndFrame();

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
      if (view.trail.visible && view.cache) writeLine(view.trail, view.cache, origin, null, p);
    }

    this.vesselTrail.visible = this.vesselCache !== null;
    if (this.vesselCache) {
      const span = this.vesselSpan;
      writeLine(this.vesselTrail, this.vesselCache, origin, null, vesselFrame, {
        rgb: HISTORY_RGB, headTime: null, tailTime: now, lightness: (t) => fade((now - t) / span), presentFirst: false,
      });
    }
    this.predictionLine.visible = this.predictionCache !== null && predictionEnd !== null;
    if (this.predictionCache && predictionEnd) {
      const span = this.sim.predictionHorizonSeconds;
      writeLine(this.predictionLine, this.predictionCache, origin, vesselFrame, predictionEnd, {
        rgb: PREDICTION_RGB, headTime: now, tailTime: this.sim.prediction.lastTime, lightness: (t) => fade((t - now) / span), presentFirst: true,
      });
    }
    this.updateThrustArrow(frameNow, sub(vesselFrame, origin), arrowLength);

    this.vesselMarker.classList.toggle('crashed', this.sim.impact !== null);
    this.vesselMarker.querySelector('span')!.textContent = this.sim.impact ? 'Vessel ✕ impact' : 'Vessel';

    // A label overlapping a higher-priority one keeps only its dot:
    // focus first, then the vessel, then trajectory events, then bodies by mass.
    const entries: MarkerEntry[] = this.bodies.map((view) => ({
      marker: view.marker,
      relative: sub(bodyFrame[view.body.index]!, origin),
      priority: (focus.kind === 'body' && focus.index === view.body.index ? 1e60 : 0) + view.body.massKg,
    }));
    entries.push({ marker: this.vesselMarker, relative: sub(vesselFrame, origin), priority: focus.kind === 'vessel' ? 1e60 : 1e50 });
    entries.push(...this.eventEntries(origin));
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

  private eventEntries(origin: Vec3): MarkerEntry[] {
    while (this.eventMarkers.length < this.events.length) {
      this.eventMarkers.push(createMarker(this.overlay, '', PREDICTION_COLOR, 'event'));
    }
    const entries: MarkerEntry[] = [];
    this.eventMarkers.forEach((marker, i) => {
      const event = this.events[i];
      const covered = event !== undefined && event.time >= this.sim.ephemeris.startTime && event.time <= this.sim.ephemeris.endTime;
      if (!event || !covered) {
        marker.style.display = 'none';
        return;
      }
      marker.className = `marker event ${event.kind}`;
      marker.querySelector('span')!.textContent = event.label;
      const p = toFrame(this.frame.evaluate(event.time), event.position);
      entries.push({ marker, relative: sub(p, origin), priority: 1e49 - i });
    });
    return entries;
  }

  private updateThrustArrow(frameNow: FrameState, vesselRelative: Vec3, length: number): void {
    this.thrustArrow.visible = this.sim.impact === null;
    if (!this.thrustArrow.visible) return;
    const d = directionToFrame(frameNow, this.sim.thrustDirection());
    const attribute = this.thrustArrow.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = attribute.array as Float32Array;
    const x = vesselRelative.x * RENDER_SCALE, y = vesselRelative.y * RENDER_SCALE, z = vesselRelative.z * RENDER_SCALE;
    a[0] = x; a[1] = z; a[2] = -y;
    a[3] = x + d.x * length; a[4] = z + d.z * length; a[5] = -(y + d.y * length);
    attribute.needsUpdate = true;
    this.thrustArrow.geometry.setDrawRange(0, 2);
    const burning = this.sim.throttle > 0 && this.sim.fuelKg > 0;
    (this.thrustArrow.material as THREE.LineBasicMaterial).color.set(burning ? '#ff9a3c' : '#8a7a6a');
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
      view.cache.update(now - span, now, (t) => toFrame(this.frame.evaluate(t), this.frame.position(index)));
    }
  }

  private vesselInterval(now: number, span: number): number {
    const framePeriod = this.frame.rotationPeriodSeconds(now);
    return Math.max(
      Math.min(this.vesselNaturalPeriod(now) / TRAIL_SAMPLES_PER_PERIOD, framePeriod / TRAIL_SAMPLES_PER_PERIOD),
      span / MAX_TRAIL_SAMPLES,
    );
  }

  private updateVesselCache(now: number): void {
    const span = Math.min(this.vesselSpan, now - this.sim.history.firstTime);
    if (!this.vesselCache) this.vesselCache = new PathCache(this.vesselInterval(now, this.vesselSpan));
    this.vesselCache.update(now - span, now, (t) => toFrame(this.frame.evaluate(t), this.sim.vesselPositionAt(t)));
  }

  private updatePredictionCache(now: number): void {
    const prediction = this.sim.prediction;
    if (this.sim.impact || prediction.count < 2) {
      this.predictionCache = null;
      return;
    }
    if (!this.predictionCache || this.predictionGeneration !== this.sim.predictionGeneration) {
      this.predictionGeneration = this.sim.predictionGeneration;
      this.predictionCache = new PathCache(this.vesselInterval(now, this.sim.predictionHorizonSeconds));
    }
    this.predictionCache.update(now, prediction.lastTime, (t) => toFrame(this.frame.evaluate(t), prediction.sample(t).position));
  }

  private predictionEndFrame(): Vec3 | null {
    const prediction = this.sim.prediction;
    if (this.sim.impact || prediction.count < 2) return null;
    const t = prediction.lastTime;
    return toFrame(this.frame.evaluate(t), prediction.position(prediction.count - 1));
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
    if (isStar) {
      // Mostly white so planet colours stay recognisable; decay 0 because distances span AU.
      group.add(new THREE.PointLight(new THREE.Color(body.color).lerp(new THREE.Color('#ffffff'), 0.75), 2.2, 0, 0));
    }
    const trail = createLine(body.color, 0.55);
    this.scene.add(trail);
    const marker = createMarker(this.overlay, body.name, body.color, isStar ? 'star' : 'body');
    marker.addEventListener('click', () => onPick({ kind: 'body', index: body.index }));
    return { body, group, trail, cache: null, marker };
  }

  private placeMarker(marker: HTMLDivElement, relative: Vec3, camera: THREE.Camera, width: number, height: number): { x: number; y: number } | null {
    this.projected.set(relative.x * RENDER_SCALE, relative.z * RENDER_SCALE, -relative.y * RENDER_SCALE).project(camera);
    const visible = this.projected.z > -1 && this.projected.z < 1
      && Math.abs(this.projected.x) < 1.2 && Math.abs(this.projected.y) < 1.2;
    marker.style.display = visible ? 'flex' : 'none';
    if (!visible) return null;
    const x = (this.projected.x * 0.5 + 0.5) * width;
    const y = (-this.projected.y * 0.5 + 0.5) * height;
    // Whole pixels keep the label text crisp; sub-pixel offsets make it shimmer.
    marker.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    return { x, y };
  }
}

function toThree(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.z, -v.y);
}

function setRenderPosition(target: THREE.Vector3, relative: Vec3): void {
  target.set(relative.x * RENDER_SCALE, relative.z * RENDER_SCALE, -relative.y * RENDER_SCALE);
}

const HISTORY_RGB = rgbOf(HISTORY_COLOR);
const PREDICTION_RGB = rgbOf(PREDICTION_COLOR);

function rgbOf(color: string): [number, number, number] {
  const c = new THREE.Color(color);
  return [c.r, c.g, c.b];
}

/** Lightness for a path vertex at fraction 0 (now) .. 1 (far end of its span). */
function fade(fraction: number): number {
  const f = Math.min(1, Math.max(0, fraction));
  return FADE_FLOOR + (1 - FADE_FLOOR) * (1 - f) ** 1.5;
}

interface Fade {
  rgb: readonly [number, number, number];
  headTime: number | null;
  tailTime: number | null;
  lightness: (t: number) => number;
  /** The cache runs from the present outward; reverse it so the present is drawn last. */
  presentFirst: boolean;
}

/**
 * An opaque line coloured per vertex, darkening toward black with time. It
 * depth-tests against bodies but writes no depth, so among its own
 * overlapping laps the segment drawn last wins; vertices are ordered from
 * the far end to the present so the brightest part stays on top. A high
 * renderOrder draws it after the bodies, which keep occluding it.
 */
function createFadingLine(): THREE.Line {
  const line = createLine('#ffffff', 1);
  const colors = new THREE.BufferAttribute(new Float32Array(1024 * 3), 3);
  colors.setUsage(THREE.DynamicDrawUsage);
  line.geometry.setAttribute('color', colors);
  line.material = new THREE.LineBasicMaterial({ vertexColors: true, depthWrite: false });
  line.renderOrder = 10;
  return line;
}

/** Reverse the first n vertices of an attribute array in place. */
function reverseVertices(array: Float32Array, n: number, itemSize: number): void {
  for (let i = 0, j = n - 1; i < j; i += 1, j -= 1) {
    for (let c = 0; c < itemSize; c += 1) {
      const t = array[i * itemSize + c]!;
      array[i * itemSize + c] = array[j * itemSize + c]!;
      array[j * itemSize + c] = t;
    }
  }
}

function createLine(color: string, opacity: number): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(new Float32Array(1024 * 3), 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  line.frustumCulled = false;
  return line;
}

function ensureAttribute(line: THREE.Line, name: string, itemSize: number, needed: number): THREE.BufferAttribute {
  let attribute = line.geometry.getAttribute(name) as THREE.BufferAttribute;
  if (attribute.count < needed) {
    attribute = new THREE.BufferAttribute(new Float32Array(Math.max(needed, attribute.count * 2) * itemSize), itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    line.geometry.setAttribute(name, attribute);
  }
  return attribute;
}

function writeLine(line: THREE.Line, cache: PathCache, origin: Vec3, head: Vec3 | null, tail: Vec3 | null, fading?: Fade): void {
  const needed = cache.count + 2;
  const positions = ensureAttribute(line, 'position', 3, needed);
  const written = cache.writeRelative(positions.array as Float32Array, origin, head, tail, RENDER_SCALE);
  positions.needsUpdate = true;
  if (fading) {
    const colors = ensureAttribute(line, 'color', 3, needed);
    const coloured = cache.writeColors(colors.array as Float32Array, fading.headTime, fading.tailTime, fading.rgb, fading.lightness);
    if (coloured !== written) throw new Error(`writeLine: ${written} positions but ${coloured} colours`);
    if (fading.presentFirst) {
      reverseVertices(positions.array as Float32Array, written, 3);
      reverseVertices(colors.array as Float32Array, written, 3);
    }
    colors.needsUpdate = true;
  }
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
