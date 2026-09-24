import type { LodSelection, TileColorMode } from '../lod';

export interface DebugPanelHandlers {
  onFreeze(frozen: boolean): void;
  onColorMode(mode: TileColorMode): void;
  onGridLines(enabled: boolean): void;
  onTileBorders(enabled: boolean): void;
  onSkirts(enabled: boolean): void;
  onSkirtHighlight(enabled: boolean): void;
  onHorizonCulling(enabled: boolean): void;
  onFrustumCulling(enabled: boolean): void;
  onScreenError(pixels: number): void;
}

export interface DebugStats {
  frameMilliseconds: number;
  clearanceMeters: number;
  altitudeMeters: number;
  tiltDegrees: number;
  selection: LodSelection | undefined;
  drawn: number;
  cachedTiles: number;
  nodes: number;
  workers: number;
  queued: number;
  inFlight: number;
  built: number;
  averageBuildMilliseconds: number;
  spacingMeters(level: number): number;
  frozen: boolean;
}

interface Toggle {
  readonly key: string;
  readonly label: string;
  value: boolean;
  readonly apply: (value: boolean) => void;
  input?: HTMLInputElement;
}

const COLOR_MODES: readonly TileColorMode[] = ['tint', 'level', 'terrain'];

export class DebugPanel {
  private readonly root = document.createElement('div');
  private readonly stats = document.createElement('pre');
  private readonly toggles: Toggle[];
  private readonly colorSelect = document.createElement('select');
  private readonly errorInput = document.createElement('input');
  private readonly errorLabel = document.createElement('span');

  constructor(parent: HTMLElement, private readonly handlers: DebugPanelHandlers, initialScreenError: number) {
    this.toggles = [
      { key: 'KeyF', label: 'Freeze LOD (fly out to inspect)', value: false, apply: handlers.onFreeze },
      { key: 'KeyG', label: 'Grid lines', value: false, apply: handlers.onGridLines },
      { key: 'KeyB', label: 'Tile borders', value: true, apply: handlers.onTileBorders },
      { key: 'KeyK', label: 'Skirts', value: true, apply: handlers.onSkirts },
      { key: 'KeyJ', label: 'Highlight skirts', value: false, apply: handlers.onSkirtHighlight },
      { key: 'KeyH', label: 'Horizon culling', value: true, apply: handlers.onHorizonCulling },
      { key: 'KeyU', label: 'Frustum culling', value: true, apply: handlers.onFrustumCulling },
    ];
    this.root.className = 'lod-panel';

    const title = document.createElement('div');
    title.className = 'lod-title';
    title.textContent = 'LOD LAB';
    this.root.append(title);

    for (const toggle of this.toggles) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = toggle.value;
      input.addEventListener('change', () => this.set(toggle, input.checked));
      toggle.input = input;
      label.append(input, ` ${toggle.label} `, key(toggle.key));
      this.root.append(label);
      toggle.apply(toggle.value);
    }

    const colorRow = document.createElement('label');
    for (const mode of COLOR_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = { tint: 'terrain + level tint', level: 'level only', terrain: 'terrain only' }[mode];
      this.colorSelect.append(option);
    }
    this.colorSelect.addEventListener('change', () => handlers.onColorMode(this.colorSelect.value as TileColorMode));
    colorRow.append('Color ', this.colorSelect, ' ', key('KeyC'));
    this.root.append(colorRow);
    handlers.onColorMode(COLOR_MODES[0]);

    const errorRow = document.createElement('label');
    this.errorInput.type = 'range';
    this.errorInput.min = '-1';
    this.errorInput.max = '5';
    this.errorInput.step = '0.05';
    this.errorInput.value = String(Math.log2(initialScreenError));
    this.errorInput.addEventListener('input', () => this.applyScreenError());
    errorRow.append('Max screen error ', this.errorInput, ' ', this.errorLabel, ' ', key('BracketLeft'), key('BracketRight'));
    this.root.append(errorRow);
    this.applyScreenError();

    const help = document.createElement('div');
    help.className = 'lod-help';
    help.textContent = 'Drag: move · Right/Shift-drag: turn & tilt · Wheel: altitude';
    this.root.append(help, this.stats);
    parent.append(this.root);
  }

  handleKey(code: string): void {
    const toggle = this.toggles.find((candidate) => candidate.key === code);
    if (toggle) {
      this.set(toggle, !toggle.value);
      return;
    }
    if (code === 'KeyC') {
      const next = COLOR_MODES[(COLOR_MODES.indexOf(this.colorSelect.value as TileColorMode) + 1) % COLOR_MODES.length];
      this.colorSelect.value = next;
      this.handlers.onColorMode(next);
    } else if (code === 'BracketLeft' || code === 'BracketRight') {
      this.errorInput.value = String(Number(this.errorInput.value) + (code === 'BracketLeft' ? -0.25 : 0.25));
      this.applyScreenError();
    }
  }

  update(stats: DebugStats): void {
    const selection = stats.selection;
    const levels = new Map<number, number>();
    let finest = 0;
    for (const node of selection?.render ?? []) {
      levels.set(node.key.level, (levels.get(node.key.level) ?? 0) + 1);
      finest = Math.max(finest, node.key.level);
    }
    const histogram = [...levels.entries()].sort((a, b) => a[0] - b[0])
      .map(([level, count]) => `L${level}:${count}`).join(' ');
    this.stats.textContent = [
      `frame        ${stats.frameMilliseconds.toFixed(1)} ms`,
      `clearance    ${meters(stats.clearanceMeters)}   radius-R ${meters(stats.altitudeMeters)}`,
      `tilt         ${stats.tiltDegrees.toFixed(0)}°`,
      stats.frozen ? '── SELECTION FROZEN ──' : '',
      `drawn        ${stats.drawn} tiles`,
      `finest       L${finest}  ≈ ${meters(stats.spacingMeters(finest))}/cell`,
      `levels       ${histogram}`,
      `visited      ${selection?.visited ?? 0}  culled frustum ${selection?.culled.frustum ?? 0} horizon ${selection?.culled.horizon ?? 0}`,
      `select       ${(selection?.selectMilliseconds ?? 0).toFixed(2)} ms`,
      `workers      ${stats.workers}  in flight ${stats.inFlight}  queued ${stats.queued}`,
      `built        ${stats.built}  avg ${stats.averageBuildMilliseconds.toFixed(1)} ms/tile`,
      `cache        ${stats.cachedTiles} tiles  ${stats.nodes} nodes`,
    ].filter(Boolean).join('\n');
  }

  private set(toggle: Toggle, value: boolean): void {
    toggle.value = value;
    if (toggle.input) toggle.input.checked = value;
    toggle.apply(value);
  }

  private applyScreenError(): void {
    const pixels = 2 ** Number(this.errorInput.value);
    this.errorLabel.textContent = `${pixels.toFixed(pixels < 10 ? 2 : 1)} px`;
    this.handlers.onScreenError(pixels);
  }
}

function key(code: string): HTMLElement {
  const element = document.createElement('kbd');
  element.textContent = code.replace(/^Key/, '').replace('BracketLeft', '[').replace('BracketRight', ']');
  return element;
}

function meters(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${(value / 1000).toFixed(0)} km`;
  if (magnitude >= 10_000) return `${(value / 1000).toFixed(1)} km`;
  if (magnitude >= 10) return `${value.toFixed(0)} m`;
  return `${value.toFixed(2)} m`;
}
