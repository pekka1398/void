import type { AttitudeMode, CelestialBody, FrameSpec } from '../orbit';
import { SECONDS_PER_DAY } from '../orbit';
import type { Focus } from './SceneView';
import type { SystemPresetId } from './SystemPresets';

const HOUR = 3600;
export const TRAIL_SPANS: readonly [string, number][] = [
  ['1 d', SECONDS_PER_DAY], ['7 d', 7 * SECONDS_PER_DAY], ['30 d', 30 * SECONDS_PER_DAY],
  ['90 d', 90 * SECONDS_PER_DAY], ['1 y', 365.25 * SECONDS_PER_DAY],
];
export const VESSEL_SPANS: readonly [string, number][] = [
  ['1 h', HOUR], ['6 h', 6 * HOUR], ['1 d', SECONDS_PER_DAY], ['7 d', 7 * SECONDS_PER_DAY], ['30 d', 30 * SECONDS_PER_DAY],
];

export const PREDICTION_SPANS: readonly [string, number][] = [
  ['3 h', 3 * HOUR], ['12 h', 12 * HOUR], ['1 d', SECONDS_PER_DAY], ['7 d', 7 * SECONDS_PER_DAY],
  ['30 d', 30 * SECONDS_PER_DAY], ['90 d', 90 * SECONDS_PER_DAY], ['1 y', 365.25 * SECONDS_PER_DAY],
];

export const PLAN_COAST_SPANS: readonly [string, number][] = [
  ['12 h', 12 * HOUR], ['1 d', SECONDS_PER_DAY], ['3 d', 3 * SECONDS_PER_DAY], ['7 d', 7 * SECONDS_PER_DAY],
  ['30 d', 30 * SECONDS_PER_DAY], ['90 d', 90 * SECONDS_PER_DAY], ['1 y', 365.25 * SECONDS_PER_DAY],
];
const TIME_NUDGES: readonly [string, number][] = [
  ['−1d', -SECONDS_PER_DAY], ['−1h', -HOUR], ['−10m', -600], ['−1m', -60], ['−10s', -10], ['−1s', -1],
  ['+1s', 1], ['+10s', 10], ['+1m', 60], ['+10m', 600], ['+1h', HOUR], ['+1d', SECONDS_PER_DAY],
];
const DV_STEPS = [0.01, 0.1, 1, 10, 100, 1000] as const;
export type DeltaVComponent = 'prograde' | 'normal' | 'radial';
const DV_COMPONENTS: readonly [DeltaVComponent, string][] = [['prograde', 'Prograde'], ['normal', 'Normal'], ['radial', 'Radial']];

/** One line of the burn list. */
export interface PlanRow { text: string; ok: boolean }

/** The selected burn, as the editor shows it. */
export interface BurnEditor {
  index: number;
  referenceBody: number;
  prograde: number;
  normal: number;
  radial: number;
  /** Multi-line summary: start, duration, fuel, status. */
  summary: string;
  ok: boolean;
  /** False while the burn is flying. */
  editable: boolean;
}

const ATTITUDES: readonly [AttitudeMode, string, string][] = [
  ['prograde', 'PRO', '1'], ['retrograde', 'RETRO', '2'], ['normal', 'NRM', '3'], ['antinormal', 'ANRM', '4'],
  ['radial-out', 'RAD+', '5'], ['radial-in', 'RAD−', '6'], ['hold', 'HOLD', '7'],
];

export interface PanelHandlers {
  frame(spec: FrameSpec): void;
  focus(focus: Focus): void;
  trailSpan(seconds: number): void;
  vesselSpan(seconds: number): void;
  system(id: SystemPresetId): void;
  resetVessel(): void;
  attitude(mode: AttitudeMode): void;
  /** null follows the sphere of influence. */
  reference(index: number | null): void;
  predictionHorizon(seconds: number): void;
  planAdd(): void;
  planSelect(index: number): void;
  planRemove(): void;
  planWarp(): void;
  planShift(seconds: number): void;
  planSnap(kind: 'periapsis' | 'apoapsis'): void;
  planReference(body: number): void;
  planDeltaV(component: DeltaVComponent, value: number): void;
  planCoast(seconds: number): void;
  /** A value from the startPlanes choices; resets the vessel. */
  startPlane(value: string): void;
}

type FrameKind = FrameSpec['kind'];

export class Panel {
  readonly element: HTMLDivElement;
  private readonly status: HTMLPreElement;
  private readonly readout: HTMLPreElement;
  private readonly readoutPanel: HTMLDivElement;
  private readonly frameKind: HTMLSelectElement;
  private readonly frameA: HTMLSelectElement;
  private readonly frameB: HTMLSelectElement;
  private readonly focusSelect: HTMLSelectElement;
  private readonly throttleBar: HTMLElement;
  private readonly throttleText: HTMLElement;
  private readonly attitudeButtons: Map<AttitudeMode, HTMLButtonElement> = new Map();
  private readonly planList: HTMLDivElement;
  private readonly planEditor: HTMLDivElement;
  private readonly planSummary: HTMLPreElement;
  private readonly burnReference: HTMLSelectElement;
  private readonly dvInputs: Map<DeltaVComponent, HTMLInputElement> = new Map();
  private readonly removeButton: HTMLButtonElement;
  private readonly warpButton: HTMLButtonElement;
  private dvStep = 10;
  private planListHtml = '';

  constructor(
    root: HTMLElement,
    bodies: readonly CelestialBody[],
    initial: { frame: FrameSpec; focus: Focus; trailSpan: number; vesselSpan: number; predictionSpan: number; planCoast: number; system: SystemPresetId;
      startPlanes: readonly [string, string][]; startPlane: string },
    handlers: PanelHandlers,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'panel';
    const bodyOptions = bodies.map((b) => `<option value="${b.index}">${b.name}</option>`).join('');
    const spanOptions = (spans: readonly [string, number][], selected: number) =>
      spans.map(([label, s]) => `<option value="${s}"${s === selected ? ' selected' : ''}>${label}</option>`).join('');
    this.element.innerHTML = `
      <div class="title">ORBIT LAB <small>P4 · flight plan</small></div>
      <pre class="status"></pre>
      <label>System <select data-k="system">
        <option value="sol"${initial.system === 'sol' ? ' selected' : ''}>Sol analogue</option>
        <option value="binary"${initial.system === 'binary' ? ' selected' : ''}>Astris binary</option>
      </select></label>
      <label>Frame <select data-k="frame-kind">
        <option value="barycentric">Barycentric, inertial</option>
        <option value="body-inertial">Body centred, equatorial</option>
        <option value="body-surface">Body surface, rotating</option>
        <option value="two-body-rotating">Two-body, rotating</option>
      </select></label>
      <label class="indent"><span data-k="a-label">Body</span> <select data-k="frame-a">${bodyOptions}</select></label>
      <label class="indent" data-k="b-row">Secondary <select data-k="frame-b">${bodyOptions}</select></label>
      <label>Focus <select data-k="focus"><option value="vessel">Vessel</option>${bodyOptions}</select></label>
      <label>Body trails <select data-k="trail">${spanOptions(TRAIL_SPANS, initial.trailSpan)}</select></label>
      <label>Vessel history <select data-k="vessel-span">${spanOptions(VESSEL_SPANS, initial.vesselSpan)}</select></label>
      <label>Start orbit <select data-k="start-plane">${initial.startPlanes.map(([v, label]) =>
        `<option value="${v}"${v === initial.startPlane ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <button data-k="reset">Reset vessel to start orbit</button>
      <div class="section">VESSEL</div>
      <div class="throttle"><div class="bar"><b></b></div><span>0%</span></div>
      <div class="attitude">${ATTITUDES.map(([mode, label, key]) => `<button data-mode="${mode}" title="key ${key}">${label}</button>`).join('')}</div>
      <label>Reference <select data-k="reference"><option value="auto">Auto (sphere of influence)</option>${bodyOptions}</select></label>
      <label>Prediction <select data-k="horizon">${spanOptions(PREDICTION_SPANS, initial.predictionSpan)}</select></label>
      <div class="section">FLIGHT PLAN</div>
      <label>Coast after last burn <select data-k="plan-coast">${spanOptions(PLAN_COAST_SPANS, initial.planCoast)}</select></label>
      <div class="plan-list"></div>
      <div class="plan-buttons">
        <button data-k="plan-add">+ Burn</button><button data-k="plan-remove">Delete</button><button data-k="plan-warp">Warp to burn</button>
      </div>
      <div class="plan-editor">
        <label>Reference <select data-k="burn-ref">${bodyOptions}</select></label>
        <div class="nudge">${TIME_NUDGES.map(([label, s]) => `<button data-shift="${s}">${label}</button>`).join('')}</div>
        <div class="snap"><button data-snap="periapsis">@ next Pe</button><button data-snap="apoapsis">@ next Ap</button></div>
        ${DV_COMPONENTS.map(([c, label]) => `<label class="dv">${label}
          <span><button data-dv="${c}" data-sign="-1">−</button><input type="number" step="10" data-dv="${c}"><button data-dv="${c}" data-sign="1">+</button> m/s</span></label>`).join('')}
        <label>Δv step <select data-k="dv-step">${DV_STEPS.map((v) => `<option value="${v}"${v === 10 ? ' selected' : ''}>${v} m/s</option>`).join('')}</select></label>
        <pre class="plan-summary"></pre>
      </div>
      <div class="help">
        <kbd>Space</kbd> pause · <kbd>,</kbd> <kbd>.</kbd> warp · <kbd>Tab</kbd> next focus<br>
        <kbd>Shift</kbd>/<kbd>Ctrl</kbd> throttle · <kbd>Z</kbd> full · <kbd>X</kbd> cut · <kbd>1</kbd>–<kbd>7</kbd> attitude<br>
        Wheel over a Δv field steps it; planned burns fly at full thrust.<br>
        Drag to orbit the camera, wheel to zoom, click a label to focus it.
      </div>`;
    root.append(this.element);
    this.readoutPanel = document.createElement('div');
    this.readoutPanel.className = 'panel right';
    this.readoutPanel.innerHTML = '<pre class="readout"></pre>';
    root.append(this.readoutPanel);
    const q = <T extends HTMLElement>(k: string) => {
      const el = this.element.querySelector<T>(`[data-k="${k}"]`);
      if (!el) throw new Error(`Panel: missing ${k}`);
      return el;
    };
    this.status = this.element.querySelector('.status')!;
    this.readout = this.readoutPanel.querySelector('.readout')!;
    this.frameKind = q('frame-kind');
    this.frameA = q('frame-a');
    this.frameB = q('frame-b');
    this.focusSelect = q('focus');
    this.throttleBar = this.element.querySelector<HTMLElement>('.throttle b')!;
    this.throttleText = this.element.querySelector<HTMLElement>('.throttle span')!;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('.attitude button')) {
      const mode = button.dataset.mode as AttitudeMode;
      this.attitudeButtons.set(mode, button);
      button.addEventListener('click', () => handlers.attitude(mode));
    }
    q<HTMLSelectElement>('reference').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      handlers.reference(v === 'auto' ? null : Number(v));
    });
    q<HTMLSelectElement>('horizon').addEventListener('change', (e) => handlers.predictionHorizon(Number((e.target as HTMLSelectElement).value)));
    this.planList = this.element.querySelector('.plan-list')!;
    this.planEditor = this.element.querySelector('.plan-editor')!;
    this.planSummary = this.element.querySelector('.plan-summary')!;
    this.burnReference = q('burn-ref');
    this.removeButton = q('plan-remove');
    this.warpButton = q('plan-warp');
    // Buttons never take focus, so Space keeps pausing instead of re-clicking them.
    this.element.addEventListener('mousedown', (e) => {
      if (e.target instanceof HTMLButtonElement) e.preventDefault();
    });
    this.planList.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (row) handlers.planSelect(Number(row.dataset.i));
    });
    q<HTMLButtonElement>('plan-add').addEventListener('click', () => handlers.planAdd());
    this.removeButton.addEventListener('click', () => handlers.planRemove());
    this.warpButton.addEventListener('click', () => handlers.planWarp());
    q<HTMLSelectElement>('plan-coast').addEventListener('change', (e) => handlers.planCoast(Number((e.target as HTMLSelectElement).value)));
    this.burnReference.addEventListener('change', () => handlers.planReference(Number(this.burnReference.value)));
    for (const button of this.planEditor.querySelectorAll<HTMLButtonElement>('[data-shift]')) {
      button.addEventListener('click', () => handlers.planShift(Number(button.dataset.shift)));
    }
    for (const button of this.planEditor.querySelectorAll<HTMLButtonElement>('[data-snap]')) {
      button.addEventListener('click', () => handlers.planSnap(button.dataset.snap as 'periapsis' | 'apoapsis'));
    }
    for (const input of this.planEditor.querySelectorAll<HTMLInputElement>('input[data-dv]')) {
      const component = input.dataset.dv as DeltaVComponent;
      this.dvInputs.set(component, input);
      input.addEventListener('change', () => {
        const value = Number(input.value);
        // An unparsable entry is a typing slip, not a plan: show the stored value again.
        if (input.value.trim() === '' || !Number.isFinite(value)) { input.blur(); return; }
        handlers.planDeltaV(component, value);
      });
      input.addEventListener('wheel', (e) => {
        e.preventDefault();
        handlers.planDeltaV(component, roundToStep(Number(input.value) + (e.deltaY < 0 ? 1 : -1) * this.dvStep, this.dvStep));
      }, { passive: false });
    }
    for (const button of this.planEditor.querySelectorAll<HTMLButtonElement>('button[data-dv]')) {
      const component = button.dataset.dv as DeltaVComponent;
      const input = this.dvInputs.get(component)!;
      button.addEventListener('click', () => {
        handlers.planDeltaV(component, roundToStep(Number(input.value) + Number(button.dataset.sign) * this.dvStep, this.dvStep));
      });
    }
    q<HTMLSelectElement>('dv-step').addEventListener('change', (e) => {
      this.dvStep = Number((e.target as HTMLSelectElement).value);
      for (const input of this.dvInputs.values()) input.step = String(this.dvStep);
    });
    this.showFrame(initial.frame);
    this.showFocus(initial.focus);

    const emitFrame = () => {
      const kind = this.frameKind.value as FrameKind;
      const a = Number(this.frameA.value);
      const b = Number(this.frameB.value);
      this.updateFrameRows(kind);
      if (kind === 'barycentric') handlers.frame({ kind });
      else if (kind === 'two-body-rotating') {
        // A frame needs two distinct bodies; keep the current frame until the choice is valid.
        this.frameB.classList.toggle('invalid', a === b);
        if (a !== b) handlers.frame({ kind, primary: a, secondary: b });
      } else handlers.frame({ kind, body: a });
    };
    this.frameKind.addEventListener('change', emitFrame);
    this.frameA.addEventListener('change', emitFrame);
    this.frameB.addEventListener('change', emitFrame);
    this.focusSelect.addEventListener('change', () => {
      const v = this.focusSelect.value;
      handlers.focus(v === 'vessel' ? { kind: 'vessel' } : { kind: 'body', index: Number(v) });
    });
    q<HTMLSelectElement>('trail').addEventListener('change', (e) => handlers.trailSpan(Number((e.target as HTMLSelectElement).value)));
    q<HTMLSelectElement>('vessel-span').addEventListener('change', (e) => handlers.vesselSpan(Number((e.target as HTMLSelectElement).value)));
    q<HTMLSelectElement>('system').addEventListener('change', (e) => handlers.system((e.target as HTMLSelectElement).value as SystemPresetId));
    q<HTMLButtonElement>('reset').addEventListener('click', () => handlers.resetVessel());
    q<HTMLSelectElement>('start-plane').addEventListener('change', (e) => handlers.startPlane((e.target as HTMLSelectElement).value));
  }

  showFocus(focus: Focus): void {
    this.focusSelect.value = focus.kind === 'vessel' ? 'vessel' : String(focus.index);
  }

  setThrottle(value: number, burning: boolean): void {
    this.throttleBar.style.width = `${(value * 100).toFixed(1)}%`;
    this.throttleBar.classList.toggle('burning', burning);
    this.throttleText.textContent = `${Math.round(value * 100)}%`;
  }

  showAttitude(mode: AttitudeMode): void {
    for (const [m, button] of this.attitudeButtons) button.classList.toggle('active', m === mode);
  }

  /** selected indexes rows; editor is null when nothing is selected. */
  showPlan(rows: PlanRow[], selected: number | null, editor: BurnEditor | null, canWarp: boolean): void {
    const html = rows.length === 0
      ? '<div class="empty">No burns planned.</div>'
      : rows.map((row, i) => `<div data-i="${i}" class="${row.ok ? '' : 'invalid '}${i === selected ? 'selected' : ''}">${escapeHtml(row.text)}</div>`).join('');
    if (html !== this.planListHtml) {
      this.planListHtml = html;
      this.planList.innerHTML = html;
    }
    this.removeButton.disabled = editor === null || !editor.editable;
    this.warpButton.disabled = !canWarp;
    this.planEditor.style.display = editor ? '' : 'none';
    if (!editor) return;
    for (const control of this.planEditor.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')) {
      if (control.dataset.k !== 'dv-step') control.disabled = !editor.editable;
    }
    if (document.activeElement !== this.burnReference) this.burnReference.value = String(editor.referenceBody);
    for (const [component, input] of this.dvInputs) {
      if (document.activeElement !== input) input.value = String(editor[component]);
    }
    this.planSummary.textContent = editor.summary;
    this.planSummary.classList.toggle('invalid', !editor.ok);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setReadout(text: string): void {
    this.readout.textContent = text;
  }

  private showFrame(frame: FrameSpec): void {
    this.frameKind.value = frame.kind;
    if (frame.kind === 'body-inertial' || frame.kind === 'body-surface') this.frameA.value = String(frame.body);
    if (frame.kind === 'two-body-rotating') {
      this.frameA.value = String(frame.primary);
      this.frameB.value = String(frame.secondary);
    }
    this.updateFrameRows(frame.kind);
  }

  private updateFrameRows(kind: FrameKind): void {
    const aRow = this.frameA.closest('label')!;
    const bRow = this.frameB.closest('label')!;
    aRow.style.display = kind === 'barycentric' ? 'none' : '';
    bRow.style.display = kind === 'two-body-rotating' ? '' : 'none';
    this.element.querySelector('[data-k="a-label"]')!.textContent = kind === 'two-body-rotating' ? 'Primary' : 'Body';
  }
}

function roundToStep(value: number, step: number): number {
  const rounded = Math.round(value / step) * step;
  // Keep 0.1-steps free of binary fractions like 0.30000000000000004.
  return Number(rounded.toFixed(Math.max(0, -Math.floor(Math.log10(step)))));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
