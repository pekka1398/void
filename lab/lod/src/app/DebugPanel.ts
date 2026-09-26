import type { LodSelection, TileColorMode } from '../lod';
import { PLANET_PRESETS, type PlanetPresetId } from './PlanetPresets';

export interface DebugPanelHandlers {
  onPreset(id: PlanetPresetId): void;
  onFreeze(frozen: boolean): void;
  onColorMode(mode: TileColorMode): void;
  onGridLines(enabled: boolean): void;
  onMeshWireframe(enabled: boolean): void;
  onTileBoundaries(enabled: boolean): void;
  onSkirts(enabled: boolean): void;
  onSkirtHighlight(enabled: boolean): void;
  onCameraLod(enabled: boolean): void;
  onHorizonCulling(enabled: boolean): void;
  onLodDistanceScale(scale: number): void;
  onMinObserverCellPixels(pixels: number): void;
}

export interface DebugStats {
  frameMilliseconds: number;
  centerDistanceMeters: number;
  altitudeMeters: number;
  tiltDegrees: number;
  probeRadiusMeters: number;
  probeAltitudeMeters: number;
  probeThetaDegrees: number;
  probePhiDegrees: number;
  probeDistanceMeters: number;
  selection: LodSelection | undefined;
  drawn: number;
  cachedTiles: number;
  cachedMeshBytes: number;
  rendererCopyBytes: number;
  nodes: number;
  workers: number;
  queued: number;
  inFlight: number;
  built: number;
  averageBuildMilliseconds: number;
  averageSampleMilliseconds: number;
  averageFinishMilliseconds: number;
  syncMilliseconds: number;
  renderWaitMilliseconds: number;
  gpuCreated: number;
  gpuDisposed: number;
  drawCalls: number;
  triangles: number;
  lines: number;
  spacingMeters(level: number): number;
  frozen: boolean;
  /** Benchmark progress, when one is running. */
  bench?: string;
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
  private readonly presetSelect = document.createElement('select');
  private readonly errorInput = document.createElement('input');
  private readonly errorLabel = document.createElement('span');
  private readonly pixelInput = document.createElement('input');
  private readonly pixelLabel = document.createElement('span');

  constructor(parent: HTMLElement, private readonly handlers: DebugPanelHandlers, initialLodDistanceScale: number,
    initialMinObserverCellPixels: number,
    initialDebug: { readonly meshWireframe: boolean; readonly tileBoundaries: boolean; readonly skirts: boolean;
      readonly cameraLod: boolean; readonly horizonCulling: boolean; readonly colorMode: TileColorMode }, presetId: PlanetPresetId) {
    this.toggles = [
      { key: 'KeyF', label: 'Freeze LOD (fly out to inspect)', value: false, apply: handlers.onFreeze },
      { key: 'KeyG', label: 'Grid lines', value: false, apply: handlers.onGridLines },
      { key: 'KeyB', label: 'Mesh triangles', value: initialDebug.meshWireframe, apply: handlers.onMeshWireframe },
      { key: 'KeyC', label: 'Tile boundaries', value: initialDebug.tileBoundaries, apply: handlers.onTileBoundaries },
      { key: 'KeyK', label: 'Skirts', value: initialDebug.skirts, apply: handlers.onSkirts },
      { key: 'KeyJ', label: 'Highlight skirts', value: false, apply: handlers.onSkirtHighlight },
      { key: 'KeyV', label: 'Camera drives LOD (detail + horizon)', value: initialDebug.cameraLod, apply: handlers.onCameraLod },
      { key: 'KeyH', label: 'Horizon culling (camera, else probe)', value: initialDebug.horizonCulling, apply: handlers.onHorizonCulling },
    ];
    this.root.className = 'lod-panel';

    const title = document.createElement('div');
    title.className = 'lod-title';
    title.textContent = 'LOD LAB';
    this.root.append(title);

    const presetRow = document.createElement('label');
    for (const [id, preset] of Object.entries(PLANET_PRESETS)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = preset.name;
      this.presetSelect.append(option);
    }
    this.presetSelect.value = presetId;
    this.presetSelect.addEventListener('change', () => {
      const nextId = this.presetSelect.value;
      if (!Object.hasOwn(PLANET_PRESETS, nextId)) throw new Error(`DebugPanel.ts: invalid selected preset=${nextId}`);
      handlers.onPreset(nextId as PlanetPresetId);
    });
    presetRow.append('Planet ', this.presetSelect);
    this.root.append(presetRow);

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
    this.colorSelect.value = initialDebug.colorMode;
    colorRow.append('Color ', this.colorSelect, ' ', key('KeyC'));
    this.root.append(colorRow);
    handlers.onColorMode(initialDebug.colorMode);

    const errorRow = document.createElement('label');
    this.errorInput.type = 'range';
    this.errorInput.min = '-2';
    this.errorInput.max = '2';
    this.errorInput.step = '0.05';
    this.errorInput.value = String(Math.log2(initialLodDistanceScale));
    this.errorInput.addEventListener('input', () => this.applyLodDistanceScale());
    errorRow.append('LOD distance scale ', this.errorInput, ' ', this.errorLabel, ' ', key('BracketLeft'), key('BracketRight'));
    this.root.append(errorRow);
    this.applyLodDistanceScale();

    const pixelRow = document.createElement('label');
    this.pixelInput.type = 'range';
    this.pixelInput.min = '0';
    this.pixelInput.max = '8';
    this.pixelInput.step = '0.5';
    this.pixelInput.value = String(initialMinObserverCellPixels);
    this.pixelInput.addEventListener('input', () => this.applyMinObserverCellPixels());
    pixelRow.append('Probe min cell ', this.pixelInput, ' ', this.pixelLabel, ' ', key('Comma'), key('Period'));
    this.root.append(pixelRow);
    this.applyMinObserverCellPixels();

    const help = document.createElement('div');
    help.className = 'lod-help';
    help.textContent = 'Left drag: pan · Right drag: orbit planet center · Shift + left: look/tilt · Wheel: zoom · Drag along colored probe arrows: r / θ / φ';
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
      const next = COLOR_MODES[(COLOR_MODES.indexOf(this.colorSelect.value as TileColorMode) + 1) % COLOR_MODES.length]!;
      this.colorSelect.value = next;
      this.handlers.onColorMode(next);
    } else if (code === 'BracketLeft' || code === 'BracketRight') {
      this.errorInput.value = String(Number(this.errorInput.value) + (code === 'BracketLeft' ? -0.25 : 0.25));
      this.applyLodDistanceScale();
    } else if (code === 'Comma' || code === 'Period') {
      this.pixelInput.value = String(Number(this.pixelInput.value) + (code === 'Comma' ? -0.5 : 0.5));
      this.applyMinObserverCellPixels();
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
      `center r     ${meters(stats.centerDistanceMeters)}   radius-R ${meters(stats.altitudeMeters)}`,
      `tilt         ${stats.tiltDegrees.toFixed(0)}°`,
      `probe        r ${meters(stats.probeRadiusMeters)}  θ ${stats.probeThetaDegrees.toFixed(1)}°  φ ${stats.probePhiDegrees.toFixed(1)}°`,
      `probe alt    ${meters(stats.probeAltitudeMeters)}  camera gap ${meters(stats.probeDistanceMeters)}`,
      stats.frozen ? '── SELECTION FROZEN ──' : '',
      stats.bench ? `── ${stats.bench} ──` : '',
      `drawn        ${stats.drawn} tiles`,
      `finest       L${finest}  ≈ ${meters(stats.spacingMeters(finest))}/cell`,
      `levels       ${histogram}`,
      `visited      ${selection?.visited ?? 0}  culled horizon ${selection?.culled.horizon ?? 0}`,
      `select       ${(selection?.selectMilliseconds ?? 0).toFixed(2)} ms  walk ${(selection?.traversalMilliseconds ?? 0).toFixed(2)}  balance ${(selection?.balanceMilliseconds ?? 0).toFixed(2)}  evict ${(selection?.evictionMilliseconds ?? 0).toFixed(2)}`,
      `main         sync ${stats.syncMilliseconds.toFixed(2)} ms  renderAsync ${stats.renderWaitMilliseconds.toFixed(2)} ms`,
      `GPU objects  +${stats.gpuCreated} / -${stats.gpuDisposed} tiles this frame`,
      `draw         ${stats.drawCalls} calls  ${stats.triangles} triangles  ${stats.lines} lines`,
      `workers      ${stats.workers}  in flight ${stats.inFlight}  queued ${stats.queued}`,
      `built        ${stats.built}  avg ${stats.averageBuildMilliseconds.toFixed(1)} ms/tile  sample ${stats.averageSampleMilliseconds.toFixed(1)}  finish ${stats.averageFinishMilliseconds.toFixed(1)}`,
      `cache        ${stats.cachedTiles} tiles  ${stats.nodes} nodes`,
      `buffers      cache ${mebibytes(stats.cachedMeshBytes)}  renderer copies ${mebibytes(stats.rendererCopyBytes)}`,
    ].filter(Boolean).join('\n');
  }

  private set(toggle: Toggle, value: boolean): void {
    toggle.value = value;
    if (toggle.input) toggle.input.checked = value;
    toggle.apply(value);
  }

  private applyLodDistanceScale(): void {
    const scale = 2 ** Number(this.errorInput.value);
    this.errorLabel.textContent = `${scale.toFixed(2)}×`;
    this.handlers.onLodDistanceScale(scale);
  }

  /** 0 turns the limit off: the probe's detail is built however small it is on screen. */
  private applyMinObserverCellPixels(): void {
    const pixels = Number(this.pixelInput.value);
    this.pixelLabel.textContent = pixels === 0 ? 'off' : `${pixels.toFixed(1)} px`;
    this.handlers.onMinObserverCellPixels(pixels);
  }
}

function key(code: string): HTMLElement {
  const element = document.createElement('kbd');
  element.textContent = code.replace(/^Key/, '').replace('BracketLeft', '[').replace('BracketRight', ']').replace('Comma', ',').replace('Period', '.');
  return element;
}

function meters(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${(value / 1000).toFixed(0)} km`;
  if (magnitude >= 10_000) return `${(value / 1000).toFixed(1)} km`;
  if (magnitude >= 10) return `${value.toFixed(0)} m`;
  return `${value.toFixed(2)} m`;
}

function mebibytes(bytes: number): string { return `${(bytes / 1_048_576).toFixed(1)} MiB`; }
