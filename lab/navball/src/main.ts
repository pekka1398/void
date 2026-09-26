import { headingPitch, horizonAxes, navballBasis, NavballWidget, type NavballInput, type Vec3 } from './Navball';
import './style.css';

let stopped = false;
function panic(error: unknown): never {
  const failure = error instanceof Error ? error : new Error(`Non-Error thrown: ${String(error)}`);
  if (stopped) throw failure;
  stopped = true;
  const message = document.createElement('pre');
  message.className = 'panic';
  message.textContent = `NAVBALL LAB PANIC\n${failure.stack ?? failure.message}`;
  document.body.append(message);
  throw failure;
}
window.addEventListener('error', (e) => panic(e.error));
window.addEventListener('unhandledrejection', (e) => panic(e.reason));

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('navball lab: #app missing');

// A planet with its pole on +z and its prime meridian on +x; the vessel stands at longitude 0 and the chosen
// latitude. At ±90° the ball uses grid north, along the prime meridian.
const POLE: Vec3 = { x: 0, y: 0, z: 1 };
const PRIME_MERIDIAN: Vec3 = { x: 1, y: 0, z: 0 };
const TURN_DEGREES_PER_SECOND = 45;
const deg = Math.PI / 180;

const sliders = [
  ['latitude', 'Latitude', -90, 90, 25],
  ['heading', 'Nose heading', 0, 360, 90],
  ['pitch', 'Nose pitch', -90, 90, 35],
  ['roll', 'Roll', -180, 180, 0],
  ['vheading', 'Velocity heading', 0, 360, 80],
  ['vpitch', 'Velocity pitch', -90, 90, 20],
  ['speed', 'Speed (log)', -1, 2, 1],
] as const;
type SliderId = typeof sliders[number][0];

const panel = document.createElement('aside');
panel.className = 'panel';
panel.innerHTML = `<div class="title">NAVBALL LAB</div>
${sliders.map(([id, label, min, max, value]) => `<label>${label}<input id="${id}" type="range" min="${min}" max="${max}" step="${id === 'speed' ? 0.01 : 1}" value="${value}"><output id="${id}-value"></output></label>`).join('')}
<pre id="readout"></pre>
<div class="help"><kbd>W</kbd>/<kbd>S</kbd> pitch · <kbd>A</kbd>/<kbd>D</kbd> yaw · <kbd>Q</kbd>/<kbd>E</kbd> roll, about the vessel's own axes as lab/flight steers.<br>
Speed log scale: 10^slider, below 0.1 m/s the markers hide.</div>`;
document.body.append(panel);
const input = (id: SliderId) => {
  const found = panel.querySelector<HTMLInputElement>(`#${id}`);
  if (!found) throw new Error(`navball lab: slider ${id} missing`);
  return found;
};
const value = (id: SliderId) => Number(input(id).value);
const readout = panel.querySelector<HTMLElement>('#readout')!;

const big = new NavballWidget(320, window.devicePixelRatio);
const small = new NavballWidget(150, window.devicePixelRatio);
const caption = (text: string) => Object.assign(document.createElement('div'), { className: 'caption', textContent: text });
const bigBox = document.createElement('figure');
bigBox.append(big.canvas, caption('320 px'));
const smallBox = document.createElement('figure');
smallBox.append(small.canvas, caption('150 px, as in lab/flight'));
app.append(bigBox, smallBox);

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = (a: Vec3) => scale(a, 1 / Math.hypot(a.x, a.y, a.z));

const up = (): Vec3 => ({ x: Math.cos(value('latitude') * deg), y: 0, z: Math.sin(value('latitude') * deg) });
function horizon(heading: number, pitch: number): Vec3 {
  const u = up(), { north, east } = horizonAxes(u, POLE, PRIME_MERIDIAN);
  return add(add(scale(north, Math.cos(pitch * deg) * Math.cos(heading * deg)), east, Math.cos(pitch * deg) * Math.sin(heading * deg)), u, Math.sin(pitch * deg));
}

// The vessel's attitude; the sliders set it, the keys turn it about its own axes.
let nose: Vec3 = { x: 1, y: 0, z: 0 };
let top: Vec3 = { x: 0, y: 0, z: 1 };
function fromSliders(): void {
  const h = value('heading'), p = value('pitch'), r = value('roll') * deg;
  nose = horizon(h, p);
  const top0 = horizon(h, p + 90), right0 = cross(top0, nose);
  top = add(scale(top0, Math.cos(r)), right0, Math.sin(r));
}
function toSliders(): void {
  const basis = navballBasis({ nose, top, up: up(), pole: POLE, primeMeridian: PRIME_MERIDIAN, velocity: { x: 0, y: 0, z: 0 } });
  const { heading, pitch } = headingPitch(basis, nose);
  const top0 = horizon(heading, pitch + 90), right0 = cross(top0, nose);
  input('heading').value = String(heading);
  input('pitch').value = String(pitch);
  input('roll').value = String(Math.atan2(dot(top, right0), dot(top, top0)) / deg);
}
for (const [id] of sliders) input(id).addEventListener('input', () => { if (id !== 'vheading' && id !== 'vpitch' && id !== 'speed') fromSliders(); });
fromSliders();

const keys = new Set<string>();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const axis = (positive: string, negative: string) => Number(keys.has(positive)) - Number(keys.has(negative));

/** Turn by small angles about the vessel's own axes, as lab/flight's torques do. */
function turn(seconds: number): void {
  const a = TURN_DEGREES_PER_SECOND * deg * seconds;
  const right = cross(top, nose);
  const pitch = axis('KeyS', 'KeyW') * a, yaw = axis('KeyD', 'KeyA') * a, roll = axis('KeyE', 'KeyQ') * a;
  if (pitch === 0 && yaw === 0 && roll === 0) return;
  // Pitch up moves the nose toward the top, yaw right toward the right; roll (E) turns the top toward the left.
  let n = add(add(nose, top, pitch), right, yaw);
  let t = add(add(top, nose, -pitch), right, -roll);
  n = normalize(n);
  t = normalize(add(t, n, -dot(t, n)));
  nose = n; top = t;
  toSliders();
}

let last = performance.now();
function frame(now: number): void {
  if (stopped) return;
  try {
    turn(Math.min(0.05, (now - last) / 1000));
    last = now;
    for (const [id] of sliders) panel.querySelector<HTMLOutputElement>(`#${id}-value`)!.textContent =
      id === 'speed' ? `${(10 ** (value('speed') - 1)).toFixed(2)}` : `${value(id).toFixed(0)}°`;
    const speed = 10 ** (value('speed') - 1);
    const state: NavballInput = { nose, top, up: up(), pole: POLE, primeMeridian: PRIME_MERIDIAN, velocity: scale(horizon(value('vheading'), value('vpitch')), speed) };
    const reading = big.draw(state);
    small.draw(state);
    readout.textContent = `HDG ${reading.heading.toFixed(1).padStart(5, '0')}°   pitch ${reading.pitch.toFixed(1)}°\nspeed ${reading.speed.toFixed(2)} m/s`;
  } catch (error) {
    panic(error);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
