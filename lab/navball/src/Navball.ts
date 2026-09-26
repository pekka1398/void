/**
 * The navball: the sky and ground around the vessel, seen from outside along
 * its nose. The ball's centre is where the nose points; screen up is the
 * vessel's top (where the nose goes on pitch up), screen right its right.
 *
 * Everything is plain vectors in one caller-chosen frame, so the ball does
 * not care whether that frame is body-fixed or inertial.
 */

export interface Vec3 { x: number; y: number; z: number }

export interface NavballInput {
  /** The vessel's nose (thrust axis) and top (where the nose turns on pitch up). Unit and perpendicular. */
  nose: Vec3;
  top: Vec3;
  /** Local vertical, away from the body's centre. Unit. */
  up: Vec3;
  /** The body's north pole (spin axis). Unit. */
  pole: Vec3;
  /** The body's prime meridian (longitude 0) on its equator. Unit, perpendicular to `pole`; north exactly at a pole. */
  primeMeridian: Vec3;
  /** Velocity for the prograde and retrograde markers; below MARKER_MIN_SPEED they are hidden. */
  velocity: Vec3;
}

/**
 * Below this length of pole x up the vessel is at a pole to double precision. No field of north can be
 * continuous over the whole sphere (the hairy ball theorem), so the pole needs its own north: grid north,
 * along the prime meridian, as polar navigation uses.
 */
const POLE_EPSILON = 1e-12;
/** Below this speed, m/s, the velocity has no useful direction and the markers are not drawn. */
export const MARKER_MIN_SPEED = 0.1;
const UNIT_TOLERANCE = 1e-5;

export interface NavballBasis {
  /** Screen axes in the caller's frame: right, up (the vessel's top) and out of the screen (the nose). */
  right: Vec3;
  top: Vec3;
  nose: Vec3;
  /** Local horizon axes. */
  up: Vec3;
  north: Vec3;
  east: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });

function requireUnit(name: string, v: Vec3): void {
  if (!(Math.abs(length(v) - 1) <= UNIT_TOLERANCE)) throw new Error(`navball: ${name} is not a unit vector (length ${length(v)})`);
}

/** North and east on the local horizon: true north, or grid north exactly at a pole. */
export function horizonAxes(up: Vec3, pole: Vec3, primeMeridian: Vec3): { north: Vec3; east: Vec3 } {
  for (const [name, v] of [['up', up], ['pole', pole], ['primeMeridian', primeMeridian]] as const) requireUnit(name, v);
  if (!(Math.abs(dot(pole, primeMeridian)) <= UNIT_TOLERANCE)) {
    throw new Error(`navball: prime meridian is not on the equator (dot with the pole ${dot(pole, primeMeridian)})`);
  }
  const eastRaw = cross(pole, up);
  const eastLength = length(eastRaw);
  if (eastLength < POLE_EPSILON) {
    // At a pole up is along the pole, so the prime meridian already lies on the horizon.
    return { north: primeMeridian, east: cross(primeMeridian, up) };
  }
  const east = scale(eastRaw, 1 / eastLength);
  return { north: cross(up, east), east };
}

export function navballBasis(input: NavballInput): NavballBasis {
  for (const name of ['nose', 'top'] as const) requireUnit(name, input[name]);
  if (!(Math.abs(dot(input.nose, input.top)) <= UNIT_TOLERANCE)) {
    throw new Error(`navball: nose and top are not perpendicular (dot ${dot(input.nose, input.top)})`);
  }
  const { north, east } = horizonAxes(input.up, input.pole, input.primeMeridian);
  return { right: cross(input.top, input.nose), top: input.top, nose: input.nose, up: input.up, north, east };
}

/** A direction on the ball: x right, y up, z toward the viewer (visible when z >= 0), on the unit disc. */
export function toBall(basis: NavballBasis, direction: Vec3): Vec3 {
  return { x: dot(direction, basis.right), y: dot(direction, basis.top), z: dot(direction, basis.nose) };
}

/** Heading (degrees from north through east, [0, 360)) and pitch (degrees above the horizon) of a direction. */
export function headingPitch(basis: NavballBasis, direction: Vec3): { heading: number; pitch: number } {
  const n = dot(direction, basis.north), e = dot(direction, basis.east), u = dot(direction, basis.up);
  const heading = (Math.atan2(e, n) * 180) / Math.PI;
  return { heading: heading < 0 ? heading + 360 : heading, pitch: (Math.atan2(u, Math.hypot(n, e)) * 180) / Math.PI };
}

/** The direction at a heading and pitch, degrees. */
export function horizonDirection(basis: NavballBasis, headingDegrees: number, pitchDegrees: number): Vec3 {
  const h = (headingDegrees * Math.PI) / 180, p = (pitchDegrees * Math.PI) / 180;
  const c = Math.cos(p), n = c * Math.cos(h), e = c * Math.sin(h), u = Math.sin(p);
  return {
    x: n * basis.north.x + e * basis.east.x + u * basis.up.x,
    y: n * basis.north.y + e * basis.east.y + u * basis.up.y,
    z: n * basis.north.z + e * basis.east.z + u * basis.up.z,
  };
}

export interface NavballReadout { heading: number; pitch: number; speed: number }

const SKY = [58, 128, 214] as const;
const GROUND = [150, 96, 48] as const;
const PROGRADE = '#f2e24a';
const RETICLE = '#ffa11a';
const HEADING_LABELS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

/** Draws the navball into its own canvas, sky and ground per pixel, lines and markers on top. */
export class NavballWidget {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly size: number;
  private readonly pixelRatio: number;

  constructor(diameterCssPixels: number, pixelRatio: number) {
    if (!(diameterCssPixels > 0) || !(pixelRatio > 0)) throw new Error(`navball: bad size ${diameterCssPixels} at ratio ${pixelRatio}`);
    this.pixelRatio = pixelRatio;
    this.size = Math.round(diameterCssPixels * pixelRatio);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.canvas.style.width = `${diameterCssPixels}px`;
    this.canvas.style.height = `${diameterCssPixels}px`;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('navball: no 2D canvas context');
    this.context = context;
    this.image = context.createImageData(this.size, this.size);
  }

  draw(input: NavballInput): NavballReadout {
    const basis = navballBasis(input);
    this.fill(basis);
    const ctx = this.context;
    ctx.putImageData(this.image, 0, 0);
    ctx.save();
    ctx.translate(this.size / 2, this.size / 2);
    ctx.scale(this.pixelRatio, this.pixelRatio);
    const radius = this.size / 2 / this.pixelRatio - 1;
    this.drawGrid(basis, radius);
    const speed = length(input.velocity);
    if (speed >= MARKER_MIN_SPEED) {
      const direction = scale(input.velocity, 1 / speed);
      this.drawMarker(toBall(basis, direction), radius, false);
      this.drawMarker(toBall(basis, scale(direction, -1)), radius, true);
    }
    this.drawReticle(radius);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1a2030';
    ctx.stroke();
    ctx.restore();
    return { ...headingPitch(basis, basis.nose), speed };
  }

  /** Sky above the horizon, ground below, darkened toward the rim. */
  private fill(basis: NavballBasis): void {
    const data = this.image.data;
    const size = this.size;
    const r = size / 2 - this.pixelRatio;
    // The local vertical in screen axes: a pixel's height above the horizon is its ball point along it.
    const ux = dot(basis.up, basis.right), uy = dot(basis.up, basis.top), uz = dot(basis.up, basis.nose);
    for (let py = 0; py < size; py += 1) {
      const sy = (size / 2 - py - 0.5) / r;
      for (let px = 0; px < size; px += 1) {
        const sx = (px + 0.5 - size / 2) / r;
        const rr = sx * sx + sy * sy;
        const i = (py * size + px) * 4;
        const edge = Math.min(1, Math.max(0, (1 - Math.sqrt(rr)) * r + 0.5));
        if (edge <= 0) { data[i + 3] = 0; continue; }
        const sz = Math.sqrt(Math.max(0, 1 - rr));
        const height = sx * ux + sy * uy + sz * uz;
        // Half a pixel of blend across the horizon; the horizon line covers it.
        const t = Math.min(1, Math.max(0, height * r + 0.5));
        const shade = 0.5 + 0.5 * sz;
        data[i] = (GROUND[0] + (SKY[0] - GROUND[0]) * t) * shade;
        data[i + 1] = (GROUND[1] + (SKY[1] - GROUND[1]) * t) * shade;
        data[i + 2] = (GROUND[2] + (SKY[2] - GROUND[2]) * t) * shade;
        data[i + 3] = 255 * edge;
      }
    }
  }

  private drawGrid(basis: NavballBasis, radius: number): void {
    const ctx = this.context;
    const polyline = (points: Vec3[]) => {
      ctx.beginPath();
      let drawing = false;
      for (const p of points) {
        if (p.z < 0) { drawing = false; continue; }
        if (drawing) ctx.lineTo(p.x * radius, -p.y * radius);
        else ctx.moveTo(p.x * radius, -p.y * radius);
        drawing = true;
      }
      ctx.stroke();
    };
    // Pitch circles every 10 degrees, brighter every 30; the horizon white and thick.
    for (let pitch = -80; pitch <= 80; pitch += 10) {
      const points: Vec3[] = [];
      for (let heading = 0; heading <= 360; heading += 3) points.push(toBall(basis, horizonDirection(basis, heading, pitch)));
      ctx.lineWidth = pitch === 0 ? 2 : 1;
      ctx.strokeStyle = pitch === 0 ? '#ffffff' : pitch % 30 === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)';
      polyline(points);
    }
    // Heading meridians every 30 degrees, from pole to pole.
    for (let heading = 0; heading < 360; heading += 30) {
      const points: Vec3[] = [];
      for (let pitch = -90; pitch <= 90; pitch += 3) points.push(toBall(basis, horizonDirection(basis, heading, pitch)));
      ctx.lineWidth = 1;
      ctx.strokeStyle = heading % 90 === 0 ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.3)';
      polyline(points);
    }
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = (direction: Vec3, text: string) => {
      const p = toBall(basis, direction);
      // Labels near the rim are squashed and crowded; only the front of the ball is labelled.
      if (p.z < 0.35) return;
      ctx.globalAlpha = Math.min(1, (p.z - 0.35) / 0.2);
      ctx.fillStyle = '#000000aa';
      ctx.fillText(text, p.x * radius + 1, -p.y * radius + 1);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, p.x * radius, -p.y * radius);
      ctx.globalAlpha = 1;
    };
    for (let heading = 0; heading < 360; heading += 30) label(horizonDirection(basis, heading, 4), HEADING_LABELS[heading] ?? String(heading));
    // Pitch numbers ride on the meridian under the nose, so they stay near the middle of the ball.
    const noseHeading = headingPitch(basis, basis.nose).heading;
    for (const pitch of [-60, -30, 30, 60]) label(horizonDirection(basis, noseHeading + 12, pitch), String(pitch));
  }

  /** Prograde: a circle with three ticks. Retrograde: a circle with a cross. */
  private drawMarker(p: Vec3, radius: number, retrograde: boolean): void {
    if (p.z < 0) return;
    const ctx = this.context;
    const x = p.x * radius, y = -p.y * radius, r = 6;
    const shape = () => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      if (retrograde) {
        const d = r * 0.7;
        ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
      } else {
        ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 5);
        ctx.moveTo(x - r, y); ctx.lineTo(x - r - 5, y);
        ctx.moveTo(x + r, y); ctx.lineTo(x + r + 5, y);
        ctx.moveTo(x + 1.5, y); ctx.arc(x, y, 1.5, 0, 2 * Math.PI);
      }
    };
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#000000aa';
    shape();
    ctx.stroke();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = PROGRADE;
    shape();
    ctx.stroke();
  }

  /** The fixed vessel mark at the centre: wings and a chevron. */
  private drawReticle(radius: number): void {
    const ctx = this.context;
    const w = radius * 0.32;
    const shape = () => {
      ctx.beginPath();
      ctx.moveTo(-w, 0); ctx.lineTo(-w * 0.35, 0); ctx.lineTo(0, w * 0.3); ctx.lineTo(w * 0.35, 0); ctx.lineTo(w, 0);
      ctx.moveTo(0, -3); ctx.lineTo(0, 3);
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#000000aa';
    shape();
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = RETICLE;
    shape();
    ctx.stroke();
  }
}
