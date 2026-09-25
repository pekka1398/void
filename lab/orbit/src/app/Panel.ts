import type { CelestialBody, FrameSpec } from '../orbit';
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

export interface PanelHandlers {
  frame(spec: FrameSpec): void;
  focus(focus: Focus): void;
  trailSpan(seconds: number): void;
  vesselSpan(seconds: number): void;
  system(id: SystemPresetId): void;
  resetVessel(): void;
}

type FrameKind = FrameSpec['kind'];

export class Panel {
  readonly element: HTMLDivElement;
  private readonly status: HTMLPreElement;
  private readonly readout: HTMLPreElement;
  private readonly frameKind: HTMLSelectElement;
  private readonly frameA: HTMLSelectElement;
  private readonly frameB: HTMLSelectElement;
  private readonly focusSelect: HTMLSelectElement;

  constructor(
    root: HTMLElement,
    bodies: readonly CelestialBody[],
    initial: { frame: FrameSpec; focus: Focus; trailSpan: number; vesselSpan: number; system: SystemPresetId },
    handlers: PanelHandlers,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'panel';
    const bodyOptions = bodies.map((b) => `<option value="${b.index}">${b.name}</option>`).join('');
    const spanOptions = (spans: readonly [string, number][], selected: number) =>
      spans.map(([label, s]) => `<option value="${s}"${s === selected ? ' selected' : ''}>${label}</option>`).join('');
    this.element.innerHTML = `
      <div class="title">ORBIT LAB <small>P2 · viewer</small></div>
      <pre class="status"></pre>
      <label>System <select data-k="system">
        <option value="sol"${initial.system === 'sol' ? ' selected' : ''}>Sol analogue</option>
        <option value="binary"${initial.system === 'binary' ? ' selected' : ''}>Astris binary</option>
      </select></label>
      <label>Frame <select data-k="frame-kind">
        <option value="barycentric">Barycentric, inertial</option>
        <option value="body-inertial">Body centred, inertial</option>
        <option value="body-surface">Body surface, rotating</option>
        <option value="two-body-rotating">Two-body, rotating</option>
      </select></label>
      <label class="indent"><span data-k="a-label">Body</span> <select data-k="frame-a">${bodyOptions}</select></label>
      <label class="indent" data-k="b-row">Secondary <select data-k="frame-b">${bodyOptions}</select></label>
      <label>Focus <select data-k="focus"><option value="vessel">Vessel</option>${bodyOptions}</select></label>
      <label>Body trails <select data-k="trail">${spanOptions(TRAIL_SPANS, initial.trailSpan)}</select></label>
      <label>Vessel history <select data-k="vessel-span">${spanOptions(VESSEL_SPANS, initial.vesselSpan)}</select></label>
      <button data-k="reset">Reset vessel to start orbit</button>
      <pre class="readout"></pre>
      <div class="help">
        <kbd>Space</kbd> pause · <kbd>,</kbd> <kbd>.</kbd> warp · <kbd>Tab</kbd> next focus<br>
        Drag to orbit the camera, wheel to zoom, click a label to focus it.
      </div>`;
    root.append(this.element);
    const q = <T extends HTMLElement>(k: string) => {
      const el = this.element.querySelector<T>(`[data-k="${k}"]`);
      if (!el) throw new Error(`Panel: missing ${k}`);
      return el;
    };
    this.status = this.element.querySelector('.status')!;
    this.readout = this.element.querySelector('.readout')!;
    this.frameKind = q('frame-kind');
    this.frameA = q('frame-a');
    this.frameB = q('frame-b');
    this.focusSelect = q('focus');
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
  }

  showFocus(focus: Focus): void {
    this.focusSelect.value = focus.kind === 'vessel' ? 'vessel' : String(focus.index);
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
