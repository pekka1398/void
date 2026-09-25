import type { AttitudeMode, CelestialBody, FrameSpec } from '../orbit';
import { SECONDS_PER_DAY } from '../orbit';
import { DigitField, durationFormat, speedFormat } from './DigitField';
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

/** Shortest coast the panel allows. */
const MIN_COAST_SECONDS = 60;
/** The digit fields reach 999 days. */
const MAX_DAYS_SECONDS = 999 * SECONDS_PER_DAY + 86_399;
export type DeltaVComponent = 'prograde' | 'normal' | 'radial';
const DV_COMPONENTS: readonly [DeltaVComponent, string][] = [['prograde', 'Prograde'], ['normal', 'Normal'], ['radial', 'Radial']];

/** One line of the burn list. */
export interface PlanRow { text: string; ok: boolean }

/** The selected burn, as the editor shows it. */
export interface BurnEditor {
  index: number;
  referenceBody: number;
  /** The reference follows the sphere of influence at ignition. */
  referenceAuto: boolean;
  referenceName: string;
  /** Absolute mission time, s. */
  startTime: number;
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
  /** Absolute mission time of the selected burn's start. */
  planStart(time: number): void;
  planSnap(kind: 'periapsis' | 'apoapsis'): void;
  /** A body, or 'auto' for the sphere of influence at ignition. */
  planReference(body: number | 'auto'): void;
  planDeltaV(component: DeltaVComponent, value: number): void;
  planCoast(seconds: number): void;
  /** A value from the startPlanes choices; resets the vessel. */
  startPlane(value: string): void;
  /** Body drawn alongside the plan, null for none. */
  planTarget(index: number | null): void;
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
  private readonly dvFields: Map<DeltaVComponent, DigitField> = new Map();
  private readonly startField: DigitField;
  private readonly coastField: DigitField;
  private readonly removeButton: HTMLButtonElement;
  private readonly warpButton: HTMLButtonElement;
  private planListHtml = '';

  constructor(
    root: HTMLElement,
    bodies: readonly CelestialBody[],
    initial: { frame: FrameSpec; focus: Focus; trailSpan: number; vesselSpan: number; predictionSpan: number; planCoast: number; system: SystemPresetId;
      startPlanes: readonly [string, string][]; startPlane: string;
      planTarget: number | null },
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
      <label>Target <select data-k="plan-target"><option value="none">None</option>${bodyOptions}</select></label>
      <label>Coast after last burn <span data-k="plan-coast"></span></label>
      <div class="plan-list"></div>
      <div class="plan-buttons">
        <button data-k="plan-add">+ Burn</button><button data-k="plan-remove">Delete</button><button data-k="plan-warp">Warp to burn</button>
      </div>
      <div class="plan-editor">
        <label>Reference <select data-k="burn-ref"><option value="auto">Auto</option>${bodyOptions}</select></label>
        <label>Start T+ <span data-k="burn-start"></span></label>
        <div class="snap"><button data-snap="periapsis">@ next Pe</button><button data-snap="apoapsis">@ next Ap</button></div>
        ${DV_COMPONENTS.map(([c, label]) => `<label>${label} <span><span data-dv="${c}"></span> km/s</span></label>`).join('')}
        <pre class="plan-summary"></pre>
      </div>
      <div class="help">
        <kbd>Space</kbd> pause · <kbd>,</kbd> <kbd>.</kbd> warp · <kbd>Tab</kbd> next focus<br>
        <kbd>Shift</kbd>/<kbd>Ctrl</kbd> throttle · <kbd>Z</kbd> full · <kbd>X</kbd> cut · <kbd>1</kbd>–<kbd>7</kbd> attitude<br>
        Wheel over a digit of a plan field steps that digit; click the field to type.<br>
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
    const targetSelect = q<HTMLSelectElement>('plan-target');
    targetSelect.value = initial.planTarget === null ? 'none' : String(initial.planTarget);
    targetSelect.addEventListener('change', () => handlers.planTarget(targetSelect.value === 'none' ? null : Number(targetSelect.value)));
    this.coastField = new DigitField(durationFormat(MIN_COAST_SECONDS, MAX_DAYS_SECONDS), (v) => handlers.planCoast(v));
    q('plan-coast').append(this.coastField.element);
    this.coastField.set(initial.planCoast);
    this.startField = new DigitField(durationFormat(0, MAX_DAYS_SECONDS), (v) => handlers.planStart(v));
    q('burn-start').append(this.startField.element);
    this.burnReference.addEventListener('change', () => {
      const v = this.burnReference.value;
      handlers.planReference(v === 'auto' ? 'auto' : Number(v));
    });
    for (const button of this.planEditor.querySelectorAll<HTMLButtonElement>('[data-snap]')) {
      button.addEventListener('click', () => handlers.planSnap(button.dataset.snap as 'periapsis' | 'apoapsis'));
    }
    for (const [component] of DV_COMPONENTS) {
      const field = new DigitField(speedFormat(99_999.99), (v) => handlers.planDeltaV(component, v));
      this.planEditor.querySelector(`[data-dv="${component}"]`)!.append(field.element);
      this.dvFields.set(component, field);
    }
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
    for (const control of this.planEditor.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')) {
      control.disabled = !editor.editable;
    }
    if (document.activeElement !== this.burnReference) {
      this.burnReference.options[0]!.text = editor.referenceAuto ? `Auto → ${editor.referenceName}` : 'Auto';
      this.burnReference.value = editor.referenceAuto ? 'auto' : String(editor.referenceBody);
    }
    this.startField.setEnabled(editor.editable);
    this.startField.set(editor.startTime);
    for (const [component, field] of this.dvFields) {
      field.setEnabled(editor.editable);
      field.set(editor[component]);
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
