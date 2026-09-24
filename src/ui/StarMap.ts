import { AU_METERS, formatDistance, formatSpeed, SOLAR_RADIUS_METERS } from '../core';
import { buildGalaxyCartography, describeGalacticSystem } from './GalaxyCartography';
import {
  computeBarycenter,
  formatOrbitalTelemetry,
  formatStellarTelemetry,
  sampleOrbitalTrack,
} from './OrbitalTelemetry';

export type NavigationTargetKind = 'planet' | 'system';
export type StarMapView = 'system' | 'galaxy';

export interface MapPosition {
  x: number;
  y: number;
  z?: number;
}

export interface MapEntry {
  id: string;
  name: string;
  detail: string;
  kind: NavigationTargetKind;
  parentId?: string;
  orbitalRadiusAu?: number;
  orbitalPhase?: number;
  radiusMeters?: number;
  color?: string;
  ringed?: boolean;
  isMoon?: boolean;
  distanceMeters?: number;
  position?: MapPosition;
  starCount?: number;
  spectralClass?: string;
  orbitalPeriodSeconds?: number;
  eccentricity?: number;
  inclinationRadians?: number;
  longitudeAscendingNodeRadians?: number;
  argumentPeriapsisRadians?: number;
  orbitalSpeedMetersPerSecond?: number;
  rotationPeriodSeconds?: number;
  surfaceGravity?: number;
  massKg?: number;
  moonCount?: number;
  isLandable?: boolean;
}

export interface StarMapStar {
  id: string;
  name?: string;
  color?: string;
  position?: MapPosition;
  radius?: number;
  radiusMeters?: number;
  spectralClass?: string;
  temperatureKelvin?: number;
  distanceMeters?: number;
  luminositySolar?: number;
  orbitalPeriodSeconds?: number;
  massKg?: number;
}

export interface StarMapLayout {
  systemId: string;
  systemName: string;
  systemKind: string;
  stars: StarMapStar[];
  entries: MapEntry[];
  activeTargetId?: string;
  simulationEpochSeconds?: number;
  celestialTimeScale?: number;
  shipPosition?: MapPosition;
  shipVelocityMetersPerSecond?: number;
  shipHeadingRadians?: number;
}

export interface StarMapNode {
  entry: MapEntry;
  x: number;
  y: number;
  radius: number;
  orbitRadius: number;
  color: string;
  isMoon: boolean;
}

export interface MapGeometry {
  width: number;
  height: number;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
}

export interface MapLabelPlacement {
  side: 'left' | 'right';
  offsetY: number;
}

const TWO_PI = Math.PI * 2;
const DEFAULT_STAR_COLOR = '#ffbd59';
const DEFAULT_PLANET_COLORS = ['#54e6d4', '#f1a76f', '#a988ff', '#f27caf', '#7acfff', '#9ac99e'];

export function stableMapHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function inferMoon(entry: MapEntry): boolean {
  return entry.isMoon === true || entry.parentId !== undefined || /^MOON OF\b/i.test(entry.detail);
}

export function mapEntryColor(entry: MapEntry): string {
  if (entry.color) return entry.color;
  const description = `${entry.name} ${entry.detail}`.toLowerCase();
  if (/ice|frozen|rime|frost/.test(description)) return '#91d9ff';
  if (/ocean|water|aurelia/.test(description)) return '#52ead2';
  if (/volcan|scorch|cinder|ember/.test(description)) return '#ff8f69';
  if (/desert|arid|sand/.test(description)) return '#f1bf7b';
  if (/gas|giant/.test(description)) return '#ce9cff';
  if (/m-type|red dwarf/.test(description)) return '#ff7181';
  return DEFAULT_PLANET_COLORS[stableMapHash(entry.id) % DEFAULT_PLANET_COLORS.length]!;
}

function entryPhase(entry: MapEntry, index: number): number {
  if (entry.orbitalPhase !== undefined) return entry.orbitalPhase;
  if (entry.position) return Math.atan2(entry.position.y, entry.position.x);
  return (stableMapHash(entry.id) / 0xffff_ffff) * TWO_PI + index * 0.31;
}

export function buildStarMapNodes(
  entries: readonly MapEntry[],
  view: StarMapView,
  geometry: MapGeometry,
): StarMapNode[] {
  const { width, height, zoom = 1, offsetX = 0, offsetY = 0 } = geometry;
  const centerX = width * (view === 'system' ? 0.48 : 0.5) + offsetX;
  const centerY = height * (view === 'system' ? 0.51 : 0.49) + offsetY;

  if (view === 'galaxy') {
    const systems = entries.filter((entry) => entry.kind === 'system');
    const maximumDistance = Math.max(
      1,
      ...systems.map((entry) => {
        if (entry.position) return Math.hypot(entry.position.x, entry.position.y);
        return entry.distanceMeters ?? 0;
      }),
    );
    const extent = Math.min(width * 0.44, height * 0.43) * zoom;

    return systems.map((entry, index) => {
      const phase = entryPhase(entry, index);
      const actualRadius = entry.position
        ? Math.hypot(entry.position.x, entry.position.y)
        : entry.distanceMeters ?? maximumDistance * (0.28 + index / Math.max(systems.length, 1) * 0.64);
      const radius = extent * (0.25 + Math.log1p(actualRadius / maximumDistance * 8) / Math.log(9) * 0.75);

      return {
        entry,
        x: centerX + Math.cos(phase) * radius,
        y: centerY + Math.sin(phase) * radius * 0.74,
        radius: Math.min(7, 4 + (entry.starCount ?? 1) * 0.9),
        orbitRadius: radius,
        color: mapEntryColor(entry),
        isMoon: false,
      };
    });
  }

  const localEntries = entries.filter((entry) => entry.kind === 'planet');
  const primaries = localEntries.filter((entry) => !inferMoon(entry));
  const maximumOrbit = Math.max(1, ...primaries.map((entry, index) => entry.orbitalRadiusAu ?? index + 1));
  const extent = Math.min(width * 0.44, height * 0.56) * zoom;
  const nodes: StarMapNode[] = [];
  const nodesById = new Map<string, StarMapNode>();
  const moonsByParentId = new Map<string, StarMapNode[]>();
  let precedingPrimary: StarMapNode | undefined;
  let primaryIndex = 0;

  for (const entry of localEntries) {
    const isMoon = inferMoon(entry);
    const phase = entryPhase(entry, nodes.length);
    const parent = isMoon
      ? (entry.parentId ? nodesById.get(entry.parentId) : undefined) ?? precedingPrimary
      : undefined;

    if (parent) {
      let moonOffset = 22 + (stableMapHash(entry.id) % 11);
      const siblings = moonsByParentId.get(parent.entry.id) ?? [];
      const directionX = Math.cos(phase);
      const directionY = Math.sin(phase) * 0.78;
      const minimumSeparation = 20;
      const radialStep = Math.ceil(21 / Math.max(0.78, Math.hypot(directionX, directionY)));
      while (siblings.some((sibling) => Math.hypot(
        parent.x + directionX * moonOffset - sibling.x,
        parent.y + directionY * moonOffset - sibling.y,
      ) < minimumSeparation)) moonOffset += radialStep;
      const node = {
        entry,
        x: parent.x + directionX * moonOffset,
        y: parent.y + directionY * moonOffset,
        radius: 3.3,
        orbitRadius: moonOffset,
        color: mapEntryColor(entry),
        isMoon: true,
      };
      nodes.push(node);
      nodesById.set(entry.id, node);
      siblings.push(node);
      moonsByParentId.set(parent.entry.id, siblings);
      continue;
    }

    const orbitalDistance = entry.orbitalRadiusAu ?? primaryIndex + 1;
    const logarithmicRadius = Math.log1p(orbitalDistance / maximumOrbit * 6) / Math.log(7);
    const radius = Math.max(58, extent * (0.18 + logarithmicRadius * 0.82));
    const node = {
      entry,
      x: centerX + Math.cos(phase) * radius,
      y: centerY + Math.sin(phase) * radius * 0.62,
      radius: entry.ringed || /RINGED/i.test(entry.detail) ? 7.5 : 5.8,
      orbitRadius: radius,
      color: mapEntryColor(entry),
      isMoon: false,
    };
    nodes.push(node);
    nodesById.set(entry.id, node);
    precedingPrimary = node;
    primaryIndex += 1;
  }

  return nodes;
}

export function layoutStarMapLabels(
  nodes: readonly StarMapNode[],
  centerX: number,
  activeId?: string,
): Map<string, MapLabelPlacement> {
  const placements = new Map<string, MapLabelPlacement>();
  const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const primaries = nodes
    .filter((node) => node.entry.kind === 'planet' && !node.isMoon)
    .sort((left, right) => {
      if (left.entry.id === activeId) return -1;
      if (right.entry.id === activeId) return 1;
      return left.y - right.y || left.x - right.x;
    });

  for (const node of primaries) {
    const side = node.x < centerX - 14 ? 'left' : 'right';
    const width = Math.max(94, Math.min(160, node.entry.name.length * 7 + 20));
    const left = side === 'right' ? node.x + 16 : node.x - width - 16;
    const right = left + width;
    const candidates = [0, -25, 25, -50, 50, -75, 75, -100, 100];
    let offsetY = candidates[candidates.length - 1]!;

    for (const candidate of candidates) {
      const top = node.y + candidate - 3;
      const bottom = top + 23;
      const overlaps = occupied.some((box) =>
        left < box.right + 7 && right > box.left - 7 && top < box.bottom + 5 && bottom > box.top - 5);
      if (overlaps) continue;
      offsetY = candidate;
      break;
    }

    occupied.push({ left, right, top: node.y + offsetY - 3, bottom: node.y + offsetY + 20 });
    placements.set(node.entry.id, { side, offsetY });
  }

  return placements;
}

interface StarMapCallbacks {
  onSelect: (id: string, kind: NavigationTargetKind) => void;
  onApproach: (id: string, kind: NavigationTargetKind) => void;
  onInspect: (id: string, kind: NavigationTargetKind) => void;
  onClose: () => void;
}

export class StarMap {
  private readonly panel: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly nodesLayer: HTMLElement;
  private readonly card: HTMLElement;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly telemetry: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly scaleRuler: HTMLElement;
  private readonly coordinateReadout: HTMLElement;
  private readonly detailTelemetry: HTMLElement;
  private layout: StarMapLayout;
  private view: StarMapView = 'system';
  private zoom = 1;
  private offsetX = 0;
  private offsetY = 0;
  private pointerStart: { x: number; y: number; offsetX: number; offsetY: number } | undefined;
  private animationFrame = 0;
  private hoveredId: string | undefined;
  private activeId: string | undefined;
  private chartedCount = 0;
  private nodes: StarMapNode[] = [];
  private readonly chartStars = new Map<string, MapEntry>();
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(panel: HTMLElement, callbacks: StarMapCallbacks) {
    this.panel = panel;
    this.stage = panel.querySelector<HTMLElement>('.map-stage')!;
    this.canvas = panel.querySelector<HTMLCanvasElement>('.map-canvas')!;
    this.nodesLayer = panel.querySelector<HTMLElement>('.map-nodes')!;
    this.card = panel.querySelector<HTMLElement>('.map-detail')!;
    this.context = this.canvas.getContext('2d');
    this.layout = { systemId: '', systemName: 'CURRENT SYSTEM', systemKind: 'single', stars: [], entries: [] };

    this.telemetry = document.createElement('aside');
    this.telemetry.className = 'map-telemetry';
    this.telemetry.setAttribute('aria-label', 'Live astrometric telemetry');
    this.telemetry.innerHTML = '<div class="map-telemetry-heading">LIVE ASTROMETRY</div>' +
      '<div class="map-telemetry-row"><span class="map-telemetry-label">CELESTIAL EPOCH</span><span class="map-telemetry-value" data-map-telemetry="clock">—</span></div>' +
      '<div class="map-telemetry-row"><span class="map-telemetry-label">TEMPORAL RATE</span><span class="map-telemetry-value" data-map-telemetry="rate">1×</span></div>' +
      '<div class="map-telemetry-row"><span class="map-telemetry-label">VESSEL VELOCITY</span><span class="map-telemetry-value" data-map-telemetry="velocity">—</span></div>' +
      '<div class="map-telemetry-row"><span class="map-telemetry-label">TRACKED BODIES</span><span class="map-telemetry-value" data-map-telemetry="bodies">0</span></div>' +
      '<div class="map-telemetry-row"><span class="map-telemetry-label">STELLAR ARRAY</span><span class="map-telemetry-value" data-map-telemetry="stellar">—</span></div>' +
      '<div class="map-telemetry-row"><span class="map-telemetry-label">SURVEY EXTENT</span><span class="map-telemetry-value" data-map-telemetry="range">—</span></div>';

    this.legend = document.createElement('aside');
    this.legend.className = 'map-legend';
    this.legend.setAttribute('aria-label', 'Celestial chart legend');

    this.scaleRuler = document.createElement('div');
    this.scaleRuler.className = 'map-scale-ruler';
    this.scaleRuler.innerHTML = '<span class="map-scale-track"></span><span class="map-scale-value">—</span>';

    this.coordinateReadout = document.createElement('div');
    this.coordinateReadout.className = 'map-coordinate-readout';
    this.coordinateReadout.dataset.mapTelemetry = 'coordinates';

    this.detailTelemetry = document.createElement('div');
    this.detailTelemetry.className = 'map-detail-telemetry';
    this.card.querySelector('.map-detail-actions')?.before(this.detailTelemetry);
    this.stage.append(this.telemetry, this.legend, this.scaleRuler, this.coordinateReadout);

    for (const tab of panel.querySelectorAll<HTMLButtonElement>('[data-map-view]')) {
      tab.addEventListener('click', () => this.setView(tab.dataset.mapView as StarMapView));
    }
    panel.querySelector<HTMLButtonElement>('.map-close')?.addEventListener('click', callbacks.onClose);
    panel.querySelector<HTMLButtonElement>('.map-focus')?.addEventListener('click', () => {
      this.zoom = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.refresh();
    });
    this.stage.addEventListener('wheel', this.handleWheel, { passive: false });
    this.stage.addEventListener('pointerdown', this.handlePointerDown);
    this.stage.addEventListener('pointermove', this.handlePointerMove);
    this.stage.addEventListener('pointerup', this.handlePointerUp);
    this.stage.addEventListener('pointercancel', this.handlePointerUp);
    this.card.querySelector<HTMLButtonElement>('[data-map-action="lock"]')?.addEventListener('click', () => {
      const entry = this.findHighlighted();
      if (entry) callbacks.onSelect(entry.id, entry.kind);
    });
    this.card.querySelector<HTMLButtonElement>('[data-map-action="approach"]')?.addEventListener('click', () => {
      const entry = this.findHighlighted();
      if (entry) callbacks.onApproach(entry.id, entry.kind);
    });
    this.card.querySelector<HTMLButtonElement>('[data-map-action="inspect"]')?.addEventListener('click', () => {
      const entry = this.findHighlighted();
      if (entry) callbacks.onInspect(entry.id, entry.kind);
    });
    this.callbacks = callbacks;
  }

  private readonly callbacks: StarMapCallbacks;

  setLayout(layout: StarMapLayout): void {
    const previous = this.layout;
    const sameMembership = previous.systemId === layout.systemId &&
      this.sameIdentifiers(previous.entries, layout.entries) &&
      this.sameIdentifiers(previous.stars, layout.stars);
    this.layout = layout;
    if (layout.activeTargetId !== undefined) this.activeId = layout.activeTargetId;
    this.panel.querySelector<HTMLElement>('[data-map="system-name"]')!.textContent = layout.systemName.toUpperCase();
    this.panel.querySelector<HTMLElement>('[data-map="system-kind"]')!.textContent = `${layout.systemKind.toUpperCase()} SYSTEM`;
    this.updateChartLabel();
    if (sameMembership && this.isOpen && this.nodes.length > 0) this.refreshLive();
    else this.refresh();
  }

  private sameIdentifiers(
    previous: readonly { id: string }[],
    current: readonly { id: string }[],
  ): boolean {
    if (previous.length !== current.length) return false;
    const identities = new Set(previous.map((item) => item.id));
    return identities.size === current.length && current.every((item) => identities.has(item.id));
  }

  setChartedCount(count: number): void {
    if (this.chartedCount === count) return;
    this.chartedCount = count;
    this.updateChartLabel();
  }

  setEntries(entries: MapEntry[]): void {
    this.setLayout({ ...this.layout, entries });
  }

  setSystem(name: string, kind: string): void {
    if (this.layout.systemName === name && this.layout.systemKind === kind) return;
    this.setLayout({ ...this.layout, systemName: name, systemKind: kind });
  }

  setTarget(id: string | undefined): void {
    if (this.activeId === id) return;
    this.activeId = id;
    for (const button of this.nodesLayer.querySelectorAll<HTMLElement>('.map-entry, .map-star-node')) {
      const selected = button.dataset.id === id;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    if (id && !this.hoveredId) this.showDetail(this.findEntry(id));
    this.draw();
  }

  get isOpen(): boolean {
    return this.panel.classList.contains('open');
  }

  open(): void {
    if (this.isOpen) return;
    this.panel.classList.add('open');
    this.panel.setAttribute('aria-hidden', 'false');
    this.panel.closest('.hud')?.classList.add('map-active');
    this.refresh();
    if (!this.reducedMotion) this.animate();
  }

  close(): void {
    if (!this.isOpen) return;
    this.panel.classList.remove('open');
    this.panel.setAttribute('aria-hidden', 'true');
    this.panel.closest('.hud')?.classList.remove('map-active');
    window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  dispose(): void {
    window.cancelAnimationFrame(this.animationFrame);
    this.stage.removeEventListener('wheel', this.handleWheel);
    this.stage.removeEventListener('pointerdown', this.handlePointerDown);
    this.stage.removeEventListener('pointermove', this.handlePointerMove);
    this.stage.removeEventListener('pointerup', this.handlePointerUp);
    this.stage.removeEventListener('pointercancel', this.handlePointerUp);
  }

  private setView(view: StarMapView): void {
    if (this.view === view) return;
    this.view = view;
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.panel.dataset.view = view;
    this.panel.classList.remove('map-transitioning');
    void this.panel.offsetWidth;
    this.panel.classList.add('map-transitioning');

    for (const tab of this.panel.querySelectorAll<HTMLButtonElement>('[data-map-view]')) {
      const selected = tab.dataset.mapView === view;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    }

    this.updateChartLabel();
    this.refresh();
  }

  private updateChartLabel(): void {
    const title = this.panel.querySelector<HTMLElement>('[data-map="chart-label"]')!;
    if (this.view === 'system') {
      title.textContent = 'ORBITAL SURVEY';
      return;
    }

    const nearby = this.layout.entries.filter((entry) => entry.kind === 'system').length;
    const total = this.chartedCount > 0 ? ` · ${this.chartedCount.toLocaleString()} CHARTED` : '';
    title.textContent = `${nearby.toLocaleString()} NEARBY SYSTEMS${total}`;
  }

  private refresh(): void {
    if (!this.isOpen) return;
    const bounds = this.stage.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.nodes = buildStarMapNodes(this.layout.entries, this.view, {
      width,
      height,
      zoom: this.zoom,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    });
    this.renderNodes();
    this.updateMissionReadouts();
    this.draw();
  }

  /** Update authoritative moving-body poses without replacing focused navigation controls. */
  private refreshLive(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    this.nodes = buildStarMapNodes(this.layout.entries, this.view, {
      width,
      height,
      zoom: this.zoom,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    });

    const buttons = new Map<string, HTMLElement>();
    for (const button of this.nodesLayer.querySelectorAll<HTMLElement>('.map-entry')) {
      if (button.dataset.id) buttons.set(button.dataset.id, button);
    }

    const placements = this.view === 'system'
      ? layoutStarMapLabels(this.nodes, width * 0.48 + this.offsetX, this.activeId)
      : new Map<string, MapLabelPlacement>();

    for (const node of this.nodes) {
      const button = buttons.get(node.entry.id);
      if (!button) continue;
      button.style.left = `${node.x}px`;
      button.style.top = `${node.y}px`;
      button.style.setProperty('--node-color', node.color);
      if (node.entry.orbitalPhase !== undefined) button.dataset.orbitalPhase = String(node.entry.orbitalPhase);
      else delete button.dataset.orbitalPhase;
      if (node.entry.orbitalRadiusAu !== undefined) button.dataset.orbitalRadiusAu = String(node.entry.orbitalRadiusAu);
      else delete button.dataset.orbitalRadiusAu;
      if (node.entry.parentId) button.dataset.parentId = node.entry.parentId;
      else delete button.dataset.parentId;
      button.classList.toggle('selected', node.entry.id === this.activeId);
      button.setAttribute('aria-pressed', String(node.entry.id === this.activeId));
      button.setAttribute('aria-label', `${node.entry.name}, ${node.entry.detail}`);
      const label = placements.get(node.entry.id);
      if (label) {
        button.classList.toggle('map-node-label-left', label.side === 'left');
        button.style.setProperty('--label-offset-y', `${label.offsetY}px`);
      }
      const name = button.querySelector<HTMLElement>('.map-entry-name');
      if (name && name.textContent !== node.entry.name) name.textContent = node.entry.name;
      const detail = button.querySelector<HTMLElement>('.map-entry-meta');
      const shortDetail = this.shortDetail(node.entry);
      if (detail && detail.textContent !== shortDetail) detail.textContent = shortDetail;
      const orbitTag = button.querySelector<HTMLElement>('.map-node-orbit-tag');
      if (orbitTag) orbitTag.textContent = this.orbitTag(node.entry);
    }

    if (this.view === 'system') this.refreshStarNodes(width, height);
    if (this.hoveredId || this.activeId) this.showDetail(this.findHighlighted());
    this.updateMissionReadouts();
    this.draw();
  }

  private renderNodes(): void {
    this.nodesLayer.replaceChildren();
    this.chartStars.clear();
    const bounds = this.stage.getBoundingClientRect();
    const labelPlacements = this.view === 'system'
      ? layoutStarMapLabels(this.nodes, Math.max(1, bounds.width) * 0.48 + this.offsetX, this.activeId)
      : new Map<string, MapLabelPlacement>();

    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index]!;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `map-entry map-node${node.isMoon ? ' map-node-moon' : ''}${node.entry.kind === 'system' ? ' map-node-system' : ''}`;
      button.dataset.id = node.entry.id;
      button.dataset.kind = node.entry.kind;
      button.dataset.nodeType = node.isMoon ? 'moon' : node.entry.kind;
      if (node.entry.parentId) button.dataset.parentId = node.entry.parentId;
      if (node.entry.orbitalPhase !== undefined) button.dataset.orbitalPhase = String(node.entry.orbitalPhase);
      if (node.entry.orbitalRadiusAu !== undefined) button.dataset.orbitalRadiusAu = String(node.entry.orbitalRadiusAu);
      button.style.left = `${node.x}px`;
      button.style.top = `${node.y}px`;
      button.style.setProperty('--node-color', node.color);
      const labelPlacement = labelPlacements.get(node.entry.id);
      if (labelPlacement) {
        button.classList.toggle('map-node-label-left', labelPlacement.side === 'left');
        button.style.setProperty('--label-offset-y', `${labelPlacement.offsetY}px`);
      }
      button.setAttribute('aria-label', `${node.entry.name}, ${node.entry.detail}`);
      button.setAttribute('aria-pressed', String(node.entry.id === this.activeId));
      button.classList.toggle('selected', node.entry.id === this.activeId);
      button.innerHTML = '<span class="map-node-halo"></span><span class="map-node-core"></span>' +
        '<span class="map-node-index"></span>' +
        '<span class="map-node-copy"><span class="map-entry-name"></span><span class="map-entry-meta"></span>' +
        '<span class="map-node-orbit-tag"></span></span>';
      button.querySelector<HTMLElement>('.map-entry-name')!.textContent = node.entry.name;
      button.querySelector<HTMLElement>('.map-entry-meta')!.textContent = this.shortDetail(node.entry);
      button.querySelector<HTMLElement>('.map-node-index')!.textContent = node.isMoon
        ? '◦'
        : String(index + 1).padStart(2, '0');
      button.querySelector<HTMLElement>('.map-node-orbit-tag')!.textContent = this.orbitTag(node.entry);

      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.setTarget(node.entry.id);
        this.showDetail(this.findEntry(node.entry.id));
        this.callbacks.onSelect(node.entry.id, node.entry.kind);
      });
      button.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        this.callbacks.onApproach(node.entry.id, node.entry.kind);
      });
      button.addEventListener('mouseenter', () => {
        this.hoveredId = node.entry.id;
        this.showDetail(this.findEntry(node.entry.id));
        this.draw();
      });
      button.addEventListener('mouseleave', () => {
        this.hoveredId = undefined;
        if (this.activeId) this.showDetail(this.findEntry(this.activeId));
        this.draw();
      });
      button.addEventListener('focus', () => this.showDetail(this.findEntry(node.entry.id)));
      this.nodesLayer.append(button);
    }

    if (this.view === 'system') this.renderStarNodes();
  }

  private renderStarNodes(): void {
    const bounds = this.stage.getBoundingClientRect();
    const centerX = Math.max(1, bounds.width) * 0.48 + this.offsetX;
    const centerY = Math.max(1, bounds.height) * 0.51 + this.offsetY;

    for (let index = 0; index < this.layout.stars.length; index += 1) {
      const star = this.layout.stars[index]!;
      const point = this.starPoint(star, index, this.layout.stars, centerX, centerY);
      const entry = this.makeStarEntry(star);
      this.chartStars.set(star.id, entry);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'map-star-node';
      button.dataset.id = star.id;
      button.dataset.kind = 'planet';
      button.dataset.nodeType = 'star';
      button.style.left = `${point.x}px`;
      button.style.top = `${point.y}px`;
      button.style.setProperty('--node-color', entry.color!);
      button.setAttribute('aria-label', `${entry.name}, ${entry.detail}`);
      button.setAttribute('aria-pressed', String(star.id === this.activeId));
      button.classList.toggle('selected', star.id === this.activeId);
      button.innerHTML = '<span class="map-star-halo"></span><span class="map-star-core"></span>' +
        '<span class="map-star-copy"><span class="map-star-name"></span><span class="map-star-meta"></span></span>';
      button.querySelector<HTMLElement>('.map-star-name')!.textContent = entry.name;
      button.querySelector<HTMLElement>('.map-star-meta')!.textContent = star.spectralClass?.toUpperCase() ?? 'STAR';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.setTarget(entry.id);
        this.showDetail(this.findEntry(entry.id));
        this.callbacks.onSelect(entry.id, entry.kind);
      });
      button.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        this.callbacks.onApproach(entry.id, entry.kind);
      });
      button.addEventListener('mouseenter', () => {
        this.hoveredId = entry.id;
        this.showDetail(this.findEntry(entry.id));
        this.draw();
      });
      button.addEventListener('mouseleave', () => {
        this.hoveredId = undefined;
        if (this.activeId) this.showDetail(this.findEntry(this.activeId));
        this.draw();
      });
      button.addEventListener('focus', () => this.showDetail(this.findEntry(entry.id)));
      this.nodesLayer.append(button);
    }
  }

  private makeStarEntry(star: StarMapStar): MapEntry {
    const classification = star.spectralClass ? `${star.spectralClass.toUpperCase()}-CLASS STAR` : 'STELLAR BODY';
    const temperature = star.temperatureKelvin
      ? ` · ${Math.round(star.temperatureKelvin).toLocaleString()} K`
      : '';
    return {
      id: star.id,
      name: star.name ?? 'SYSTEM STAR',
      detail: `${classification}${temperature}`,
      kind: 'planet',
      color: star.color ?? DEFAULT_STAR_COLOR,
      spectralClass: star.spectralClass,
      distanceMeters: star.distanceMeters,
      radiusMeters: star.radiusMeters ?? star.radius,
      massKg: star.massKg,
      orbitalPeriodSeconds: star.orbitalPeriodSeconds,
    };
  }

  private refreshStarNodes(width: number, height: number): void {
    const centerX = width * 0.48 + this.offsetX;
    const centerY = height * 0.51 + this.offsetY;
    const buttons = new Map<string, HTMLElement>();
    for (const button of this.nodesLayer.querySelectorAll<HTMLElement>('.map-star-node')) {
      if (button.dataset.id) buttons.set(button.dataset.id, button);
    }

    this.chartStars.clear();
    for (let index = 0; index < this.layout.stars.length; index += 1) {
      const star = this.layout.stars[index]!;
      const entry = this.makeStarEntry(star);
      this.chartStars.set(star.id, entry);
      const button = buttons.get(star.id);
      if (!button) continue;
      const point = this.starPoint(star, index, this.layout.stars, centerX, centerY);
      button.style.left = `${point.x}px`;
      button.style.top = `${point.y}px`;
      button.style.setProperty('--node-color', entry.color!);
      button.classList.toggle('selected', star.id === this.activeId);
      button.setAttribute('aria-pressed', String(star.id === this.activeId));
      button.setAttribute('aria-label', `${entry.name}, ${entry.detail}`);
      const name = button.querySelector<HTMLElement>('.map-star-name');
      if (name && name.textContent !== entry.name) name.textContent = entry.name;
      const detail = button.querySelector<HTMLElement>('.map-star-meta');
      const spectralClass = star.spectralClass?.toUpperCase() ?? 'STAR';
      if (detail && detail.textContent !== spectralClass) detail.textContent = spectralClass;
    }
  }

  private starPoint(
    star: StarMapStar,
    index: number,
    stars: readonly StarMapStar[],
    centerX: number,
    centerY: number,
  ): { x: number; y: number } {
    if (stars.length === 1) return { x: centerX, y: centerY };

    const barycenter = computeBarycenter(stars);
    const position = star.position;
    const relativeX = position ? position.x - barycenter.x : 0;
    const relativeY = position ? position.y - barycenter.y : 0;
    const distance = Math.hypot(relativeX, relativeY);
    const maximumDistance = Math.max(
      1e-12,
      ...stars.map((candidate) => candidate.position
        ? Math.hypot(candidate.position.x - barycenter.x, candidate.position.y - barycenter.y)
        : 0),
    );
    const angle = distance > 1e-12
      ? Math.atan2(relativeY, relativeX)
      : index * TWO_PI / stars.length;
    // One common physical scale preserves the actual barycentric mass ratio.
    // Hit areas remain useful without inventing a 9px offset around every star.
    const separation = distance > 1e-12 ? distance / maximumDistance * 24 : 12 + index * 5;
    return {
      x: centerX + Math.cos(angle) * separation,
      y: centerY + Math.sin(angle) * separation * 0.64,
    };
  }

  private orbitTag(entry: MapEntry): string {
    if (entry.kind === 'system') {
      const position = describeGalacticSystem(entry);
      return position ? `${position.sector} · ${position.bearingDegrees.toFixed(0)}°` : '';
    }
    if (entry.orbitalRadiusAu === undefined || !Number.isFinite(entry.orbitalRadiusAu)) return '';
    if (inferMoon(entry)) return formatDistance(entry.orbitalRadiusAu * AU_METERS);
    return `${entry.orbitalRadiusAu.toFixed(entry.orbitalRadiusAu >= 10 ? 1 : 2)} AU`;
  }

  private updateMissionReadouts(): void {
    const set = (key: string, value: string) => {
      const output = this.telemetry.querySelector<HTMLElement>(`[data-map-telemetry="${key}"]`);
      if (output && output.textContent !== value) output.textContent = value;
    };

    const epoch = this.layout.simulationEpochSeconds;
    if (epoch !== undefined && Number.isFinite(epoch)) {
      const seconds = Math.max(0, epoch);
      const days = Math.floor(seconds / 86_400);
      const hours = Math.floor(seconds % 86_400 / 3_600);
      const minutes = Math.floor(seconds % 3_600 / 60);
      const remainder = (seconds % 60).toFixed(1).padStart(4, '0');
      set('clock', `D+${String(days).padStart(3, '0')} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${remainder}`);
      this.canvas.dataset.celestialEpoch = String(seconds);
    } else {
      set('clock', '—');
      delete this.canvas.dataset.celestialEpoch;
    }

    set('rate', `${(this.layout.celestialTimeScale ?? 1).toLocaleString('en-US', { maximumFractionDigits: 1 })}×`);
    set('velocity', this.layout.shipVelocityMetersPerSecond !== undefined
      ? formatSpeed(this.layout.shipVelocityMetersPerSecond)
      : '—');

    const planets = this.layout.entries.filter((entry) => entry.kind === 'planet' && !inferMoon(entry));
    const moons = this.layout.entries.filter((entry) => entry.kind === 'planet' && inferMoon(entry));
    set('bodies', `${planets.length} P · ${moons.length} M`);
    set('stellar', this.layout.stars.map((star) => star.spectralClass?.toUpperCase() ?? 'STAR').join(' / ') || '—');

    const systems = this.layout.entries.filter((entry) => entry.kind === 'system');
    const cartography = buildGalaxyCartography(systems);
    const farthestPlanet = Math.max(0, ...planets.map((planet) => planet.orbitalRadiusAu ?? 0));
    const extentMeters = this.view === 'system' ? farthestPlanet * AU_METERS : cartography.farthestDistanceMeters;
    set('range', extentMeters > 0 ? formatDistance(extentMeters) : '—');
    this.scaleRuler.querySelector<HTMLElement>('.map-scale-value')!.textContent = extentMeters > 0
      ? formatDistance(extentMeters / (this.view === 'system' ? 4 : 3))
      : '—';

    if (this.view === 'system' && this.layout.shipPosition) {
      const { x, y, z = 0 } = this.layout.shipPosition;
      this.coordinateReadout.textContent = `VESSEL ${x.toFixed(3)} / ${y.toFixed(3)} / ${z.toFixed(3)} AU`;
    } else if (this.view === 'galaxy') {
      const selected = this.findHighlighted();
      const position = selected?.kind === 'system' ? describeGalacticSystem(selected) : undefined;
      this.coordinateReadout.textContent = position
        ? `BRG ${position.bearingDegrees.toFixed(1)}° · ELEV ${position.elevationDegrees.toFixed(1)}° · ${position.sector}`
        : `DEPTH ±${cartography.maximumDepthLightYears.toFixed(1)} LY · ${cartography.count} VERIFIED`;
    } else {
      this.coordinateReadout.textContent = 'BARYCENTRIC FRAME · TRUE ORBITAL POSES';
    }

    if (this.legend.dataset.view !== this.view || this.legend.dataset.systemId !== this.layout.systemId) {
      this.updateLegend();
    }
  }

  private updateLegend(): void {
    this.legend.dataset.view = this.view;
    this.legend.dataset.systemId = this.layout.systemId;
    const entries = this.view === 'system'
      ? [
        { modifier: 'primary', label: 'PRIMARY STAR', color: this.layout.stars[0]?.color ?? DEFAULT_STAR_COLOR },
        ...(this.layout.stars.length > 1
          ? [{ modifier: 'secondary', label: 'COMPANION STAR', color: this.layout.stars[1]?.color ?? '#ff7181' }]
          : []),
        { modifier: 'planet', label: 'PLANET', color: '#55e9d5' },
        { modifier: 'moon', label: 'NATURAL SATELLITE', color: '#aab8ee' },
      ]
      : [
        { modifier: 'primary', label: 'CURRENT SYSTEM', color: '#00eaff' },
        { modifier: 'planet', label: 'VERIFIED SYSTEM', color: '#ffa86f' },
        { modifier: 'selected', label: 'LOCKED COURSE', color: '#ff4fae' },
      ];
    this.legend.replaceChildren(...entries.map((entry) => {
      const item = document.createElement('span');
      item.className = 'map-legend-item';
      const swatch = document.createElement('span');
      swatch.className = `map-legend-swatch map-legend-swatch--${entry.modifier}`;
      swatch.style.setProperty('--legend-color', entry.color);
      item.append(swatch, document.createTextNode(entry.label));
      return item;
    }));
  }

  private shortDetail(entry: MapEntry): string {
    const [primary] = entry.detail.split(' · ');
    if (entry.kind === 'system') return primary?.toUpperCase() ?? 'STAR SYSTEM';
    if (inferMoon(entry)) return 'MOON';
    return primary?.toUpperCase() ?? 'PLANET';
  }

  private findHighlighted(): MapEntry | undefined {
    const id = this.hoveredId ?? this.activeId;
    return id ? this.findEntry(id) : undefined;
  }

  private findEntry(id: string): MapEntry | undefined {
    return this.layout.entries.find((entry) => entry.id === id) ?? this.chartStars.get(id);
  }

  private showDetail(entry: MapEntry | undefined): void {
    if (!entry) {
      this.card.classList.remove('visible');
      return;
    }

    this.card.classList.add('visible');
    this.card.style.setProperty('--detail-color', mapEntryColor(entry));
    this.card.querySelector<HTMLElement>('[data-map="detail-name"]')!.textContent = entry.name.toUpperCase();
    this.card.querySelector<HTMLElement>('[data-map="detail-kind"]')!.textContent = entry.kind === 'system'
      ? 'INTERSTELLAR DESTINATION'
      : this.chartStars.has(entry.id) ? 'STELLAR BODY' : inferMoon(entry) ? 'NATURAL SATELLITE' : 'PLANETARY BODY';
    this.card.querySelector<HTMLElement>('[data-map="detail-description"]')!.textContent = entry.detail.toUpperCase();
    const distance = this.card.querySelector<HTMLElement>('[data-map="detail-distance"]')!;
    const range = distance.closest<HTMLElement>('.map-detail-range')!;
    range.hidden = entry.distanceMeters === undefined || !Number.isFinite(entry.distanceMeters);
    if (!range.hidden) distance.textContent = formatDistance(entry.distanceMeters!);
    this.card.querySelector<HTMLElement>('[data-map="detail-status"]')!.textContent = entry.id === this.activeId
      ? 'ACTIVE WAYPOINT'
      : 'NAVIGATION SOLUTION AVAILABLE';

    const star = this.layout.stars.find((candidate) => candidate.id === entry.id);
    const galactic = entry.kind === 'system' ? describeGalacticSystem(entry) : undefined;
    const metrics = star
      ? formatStellarTelemetry(star)
      : galactic
        ? [
          { label: 'GALACTIC X', value: `${galactic.xLightYears.toFixed(2)} ly` },
          { label: 'GALACTIC Y', value: `${galactic.yLightYears.toFixed(2)} ly` },
          { label: 'GALACTIC Z', value: `${galactic.zLightYears.toFixed(2)} ly` },
          { label: 'BEARING', value: `${galactic.bearingDegrees.toFixed(1)}° ${galactic.sector}` },
          { label: 'ELEVATION', value: `${galactic.elevationDegrees.toFixed(1)}°` },
          ...(entry.starCount !== undefined ? [{ label: 'STELLAR BODIES', value: String(entry.starCount) }] : []),
          ...(entry.spectralClass ? [{ label: 'SPECTRAL CLASS', value: entry.spectralClass.toUpperCase() }] : []),
        ]
        : formatOrbitalTelemetry(entry);
    this.updateDetailTelemetry(metrics.slice(0, 8));
  }

  private updateDetailTelemetry(metrics: readonly { label: string; value: string }[]): void {
    const existing = Array.from(this.detailTelemetry.querySelectorAll<HTMLElement>('.map-detail-metric'));
    const matching = existing.length === metrics.length && existing.every((item, index) =>
      item.dataset.metricLabel === metrics[index]?.label);
    if (matching) {
      for (let index = 0; index < metrics.length; index += 1) {
        const metric = metrics[index]!;
        const value = existing[index]!.querySelector<HTMLElement>('.map-detail-metric-value')!;
        if (value.textContent !== metric.value) value.textContent = metric.value;
      }
      return;
    }

    this.detailTelemetry.replaceChildren(...metrics.map((metric) => {
      const row = document.createElement('div');
      row.className = 'map-detail-metric';
      row.dataset.metricLabel = metric.label;
      const label = document.createElement('span');
      label.className = 'map-detail-metric-label';
      label.textContent = metric.label;
      const value = document.createElement('span');
      value.className = 'map-detail-metric-value';
      value.textContent = metric.value;
      row.append(label, value);
      return row;
    }));
  }

  private animate = (): void => {
    if (!this.isOpen) return;
    this.draw();
    this.animationFrame = window.requestAnimationFrame(this.animate);
  };

  private draw(): void {
    const context = this.context;
    if (!context || !this.isOpen) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    const centerX = width * (this.view === 'system' ? 0.48 : 0.5) + this.offsetX;
    const centerY = height * (this.view === 'system' ? 0.51 : 0.49) + this.offsetY;
    const now = performance.now() * 0.001;
    context.clearRect(0, 0, width, height);
    this.drawGrid(context, width, height);

    if (this.view === 'system') this.drawSystem(context, centerX, centerY, now);
    else this.drawGalaxy(context, centerX, centerY, now);

    const highlighted = this.nodes.find((node) => node.entry.id === (this.hoveredId ?? this.activeId));
    if (highlighted) {
      const origin = this.view === 'system'
        ? this.shipChartPosition(centerX, centerY) ?? { x: centerX, y: centerY }
        : { x: centerX, y: centerY };
      context.save();
      context.strokeStyle = `${highlighted.color}b8`;
      context.lineWidth = highlighted.entry.id === this.activeId ? 1.35 : 1;
      context.setLineDash(highlighted.entry.id === this.activeId ? [7, 5] : [2, 5]);
      context.lineDashOffset = -(now * 18 % 24);
      context.beginPath();
      context.moveTo(origin.x, origin.y);
      context.lineTo(highlighted.x, highlighted.y);
      context.stroke();

      // A traveling signal animates an authentic navigation solution, not a body.
      const progress = this.reducedMotion ? 0.5 : (now * 0.38) % 1;
      const signalX = origin.x + (highlighted.x - origin.x) * progress;
      const signalY = origin.y + (highlighted.y - origin.y) * progress;
      context.setLineDash([]);
      context.fillStyle = highlighted.color;
      context.beginPath();
      context.arc(signalX, signalY, 2.2, 0, TWO_PI);
      context.fill();
      context.restore();
    }
  }

  private drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
    context.save();
    const spacing = 48 * this.zoom;
    context.strokeStyle = 'rgba(109, 150, 177, 0.095)';
    context.lineWidth = 1;

    for (let x = ((this.offsetX % spacing) + spacing) % spacing; x < width; x += spacing) {
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, 0);
      context.lineTo(Math.round(x) + 0.5, height);
      context.stroke();
    }

    for (let y = ((this.offsetY % spacing) + spacing) % spacing; y < height; y += spacing) {
      context.beginPath();
      context.moveTo(0, Math.round(y) + 0.5);
      context.lineTo(width, Math.round(y) + 0.5);
      context.stroke();
    }

    const centerX = width * (this.view === 'system' ? 0.48 : 0.5) + this.offsetX;
    const centerY = height * (this.view === 'system' ? 0.51 : 0.49) + this.offsetY;
    context.strokeStyle = 'rgba(88, 213, 226, 0.15)';
    context.setLineDash([2, 8]);
    context.beginPath();
    context.moveTo(centerX, 0);
    context.lineTo(centerX, height);
    context.moveTo(0, centerY);
    context.lineTo(width, centerY);
    context.stroke();
    context.setLineDash([]);

    // Instrument registration marks are graph axes, never decorative stars.
    const edge = 18;
    const arm = 13;
    context.strokeStyle = 'rgba(142, 177, 208, 0.31)';
    for (const [x, y, sx, sy] of [
      [edge, edge, 1, 1],
      [width - edge, edge, -1, 1],
      [edge, height - edge, 1, -1],
      [width - edge, height - edge, -1, -1],
    ]) {
      context.beginPath();
      context.moveTo(x! + arm * sx!, y!);
      context.lineTo(x!, y!);
      context.lineTo(x!, y! + arm * sy!);
      context.stroke();
    }
    context.restore();
  }

  private drawSystem(context: CanvasRenderingContext2D, centerX: number, centerY: number, now: number): void {
    const nodesById = new Map(this.nodes.map((node) => [node.entry.id, node]));
    for (const node of this.nodes) {
      if (node.isMoon) {
        const parent = node.entry.parentId ? nodesById.get(node.entry.parentId) : undefined;
        if (!parent) continue;
        context.save();
        context.strokeStyle = node.entry.id === this.activeId
          ? 'rgba(103, 241, 231, 0.55)'
          : 'rgba(165, 187, 221, 0.23)';
        context.lineWidth = 0.85;
        context.setLineDash([2, 4]);
        const track = sampleOrbitalTrack({
          centerX: parent.x,
          centerY: parent.y,
          semiMajorAxis: node.orbitRadius,
          eccentricity: node.entry.eccentricity,
          inclinationRadians: node.entry.inclinationRadians,
          longitudeAscendingNodeRadians: node.entry.longitudeAscendingNodeRadians,
          argumentPeriapsisRadians: node.entry.argumentPeriapsisRadians,
          verticalScale: 0.78,
          segments: 40,
        });
        this.strokeTrack(context, track);
        context.restore();
        continue;
      }

      const selected = node.entry.id === this.activeId || node.entry.id === this.hoveredId;
      context.save();
      context.strokeStyle = selected ? `${node.color}99` : 'rgba(130, 159, 191, 0.25)';
      context.lineWidth = selected ? 1.4 : 0.9;
      const track = sampleOrbitalTrack({
        centerX,
        centerY,
        semiMajorAxis: node.orbitRadius,
        eccentricity: node.entry.eccentricity,
        inclinationRadians: node.entry.inclinationRadians,
        longitudeAscendingNodeRadians: node.entry.longitudeAscendingNodeRadians,
        argumentPeriapsisRadians: node.entry.argumentPeriapsisRadians,
        verticalScale: 0.62,
        segments: 72,
      });
      this.strokeTrack(context, track);

      // Tick marks annotate the true current radius, not invented objects.
      context.strokeStyle = selected ? `${node.color}bb` : 'rgba(131, 164, 198, 0.42)';
      for (const quarter of [0, 0.25, 0.5, 0.75]) {
        const point = track[Math.round(quarter * (track.length - 1))]!;
        const phase = quarter * TWO_PI;
        context.beginPath();
        context.moveTo(point.x - Math.cos(phase) * 3, point.y - Math.sin(phase) * 3);
        context.lineTo(point.x + Math.cos(phase) * 3, point.y + Math.sin(phase) * 3);
        context.stroke();
      }
      context.restore();

      if (node.entry.ringed || /RINGED/i.test(node.entry.detail)) {
        context.save();
        context.strokeStyle = 'rgba(255, 67, 187, 0.72)';
        context.lineWidth = 1.2;
        context.beginPath();
        context.ellipse(node.x, node.y, 12, 5, -0.34, 0, TWO_PI);
        context.stroke();
        context.restore();
      }
    }

    const stars: StarMapStar[] = this.layout.stars.length > 0
      ? this.layout.stars
      : [{ id: '', color: DEFAULT_STAR_COLOR }];

    if (stars.length > 1) {
      context.save();
      for (let index = 0; index < stars.length; index += 1) {
        const star = stars[index]!;
        const point = this.starPoint(star, index, stars, centerX, centerY);
        const radius = Math.hypot(point.x - centerX, (point.y - centerY) / 0.64);
        context.strokeStyle = `${star.color ?? DEFAULT_STAR_COLOR}75`;
        context.setLineDash([2, 4]);
        context.lineWidth = 0.9;
        context.beginPath();
        context.ellipse(centerX, centerY, radius, radius * 0.64, 0, 0, TWO_PI);
        context.stroke();
        context.setLineDash([]);
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.lineTo(point.x, point.y);
        context.stroke();
      }
      context.fillStyle = 'rgba(239, 249, 255, 0.9)';
      context.beginPath();
      context.arc(centerX, centerY, 2, 0, TWO_PI);
      context.fill();
      context.restore();
    }

    for (let index = 0; index < stars.length; index += 1) {
      const star = stars[index]!;
      const { x, y } = this.starPoint(star, index, stars, centerX, centerY);
      const physicalRadius = star.radiusMeters ?? star.radius;
      const radius = physicalRadius !== undefined && physicalRadius > 100
        ? Math.max(4.2, Math.min(11, Math.sqrt(physicalRadius / SOLAR_RADIUS_METERS) * 8.3))
        : Math.max(4, Math.min(10, physicalRadius ?? 7 - index));
      const color = star.color ?? (index === 0 ? DEFAULT_STAR_COLOR : '#ff7181');
      this.drawGlow(context, x, y, radius, color);
    }

    context.save();
    context.strokeStyle = 'rgba(113, 236, 238, 0.30)';
    context.setLineDash([5, 4]);
    context.lineDashOffset = -(now * 7 % 18);
    context.beginPath();
    context.arc(centerX, centerY, 34, 0, TWO_PI);
    context.stroke();
    context.restore();

    this.drawShipMarker(context, centerX, centerY);
  }

  private drawGalaxy(context: CanvasRenderingContext2D, centerX: number, centerY: number, now: number): void {
    const systems = this.layout.entries.filter((entry) => entry.kind === 'system');
    const cartography = buildGalaxyCartography(systems);
    const maxRadius = Math.min(context.canvas.width / Math.min(window.devicePixelRatio || 1, 2) * 0.44,
      context.canvas.height / Math.min(window.devicePixelRatio || 1, 2) * 0.43) * this.zoom;

    context.save();
    context.font = '9px ui-monospace, SFMono-Regular, monospace';
    const rangeBands = cartography.rangeBandsMeters.length > 0
      ? cartography.rangeBandsMeters
      : [cartography.farthestDistanceMeters].filter((distance) => distance > 0);
    for (const distanceMeters of rangeBands) {
      const ratio = distanceMeters / Math.max(cartography.farthestDistanceMeters, 1);
      const fraction = 0.25 + Math.log1p(ratio * 8) / Math.log(9) * 0.75;
      context.strokeStyle = 'rgba(138, 140, 214, 0.23)';
      context.setLineDash([3, 7]);
      context.beginPath();
      context.ellipse(centerX, centerY, maxRadius * fraction, maxRadius * fraction * 0.74, 0, 0, TWO_PI);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = 'rgba(162, 183, 214, 0.77)';
      context.fillText(formatDistance(distanceMeters).toUpperCase(), centerX + maxRadius * fraction + 7, centerY - 5);
    }

    const largestPopulation = Math.max(1, ...cartography.densitySectors.map((sector) => sector.count));
    const sectorAngle = TWO_PI / Math.max(1, cartography.densitySectors.length);
    for (const sector of cartography.densitySectors) {
      if (sector.count === 0) continue;
      const opacity = 0.12 + sector.count / largestPopulation * 0.3;
      context.strokeStyle = `rgba(115, 124, 225, ${opacity.toFixed(3)})`;
      context.lineWidth = 2.4;
      context.beginPath();
      context.ellipse(centerX, centerY, maxRadius + 10, (maxRadius + 10) * 0.74, 0,
        sector.angleRadians - sectorAngle * 0.4,
        sector.angleRadians + sectorAngle * 0.4);
      context.stroke();
    }
    context.restore();

    context.save();
    context.strokeStyle = 'rgba(0, 234, 255, 0.26)';
    context.lineWidth = 1;
    context.setLineDash([5, 6]);
    context.lineDashOffset = -(now * 8 % 22);
    context.beginPath();
    context.arc(centerX, centerY, 19, 0, TWO_PI);
    context.stroke();
    context.restore();

    this.drawGlow(context, centerX, centerY, 6.7, '#00eaff');
    delete this.canvas.dataset.shipX;
    delete this.canvas.dataset.shipY;
  }

  private strokeTrack(context: CanvasRenderingContext2D, track: readonly { x: number; y: number }[]): void {
    const start = track[0];
    if (!start) return;
    context.beginPath();
    context.moveTo(start.x, start.y);
    for (let index = 1; index < track.length; index += 1) {
      const point = track[index]!;
      context.lineTo(point.x, point.y);
    }
    context.stroke();
  }

  private shipChartPosition(centerX: number, centerY: number): { x: number; y: number } | undefined {
    const position = this.layout.shipPosition;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return undefined;
    const primaries = this.layout.entries.filter((entry) => entry.kind === 'planet' && !inferMoon(entry));
    const maximumOrbit = Math.max(1, ...primaries.map((entry, index) => entry.orbitalRadiusAu ?? index + 1));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.width / ratio;
    const height = this.canvas.height / ratio;
    const extent = Math.min(width * 0.44, height * 0.56) * this.zoom;
    const orbitalDistance = Math.hypot(position.x, position.y);
    if (orbitalDistance <= 1e-12) return { x: centerX, y: centerY };
    const logarithmicRadius = Math.log1p(orbitalDistance / maximumOrbit * 6) / Math.log(7);
    const radius = Math.max(58, extent * (0.18 + logarithmicRadius * 0.82));
    const phase = Math.atan2(position.y, position.x);
    return {
      x: centerX + Math.cos(phase) * radius,
      y: centerY + Math.sin(phase) * radius * 0.62,
    };
  }

  private drawShipMarker(context: CanvasRenderingContext2D, centerX: number, centerY: number): void {
    const point = this.shipChartPosition(centerX, centerY);
    if (!point) {
      delete this.canvas.dataset.shipX;
      delete this.canvas.dataset.shipY;
      return;
    }

    this.canvas.dataset.shipX = String(point.x);
    this.canvas.dataset.shipY = String(point.y);
    const suppliedHeading = this.layout.shipHeadingRadians;
    const heading = suppliedHeading !== undefined && Number.isFinite(suppliedHeading)
      ? Math.atan2(Math.sin(suppliedHeading) * 0.62, Math.cos(suppliedHeading))
      : undefined;
    context.save();
    context.translate(point.x, point.y);
    context.rotate((heading ?? -Math.PI * 0.5) + Math.PI * 0.5);
    context.strokeStyle = '#eff8ff';
    context.fillStyle = 'rgba(4, 15, 25, 0.96)';
    context.lineWidth = 1.4;
    context.beginPath();
    if (heading !== undefined) {
      context.moveTo(0, -8);
      context.lineTo(5, 5);
      context.lineTo(0, 2.8);
      context.lineTo(-5, 5);
    } else {
      // Without an authoritative heading, mark the vessel without inventing one.
      context.moveTo(0, -6);
      context.lineTo(6, 0);
      context.lineTo(0, 6);
      context.lineTo(-6, 0);
    }
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
  }

  private drawGlow(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string): void {
    context.save();
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius * 4);
    gradient.addColorStop(0, `${color}dd`);
    gradient.addColorStop(0.28, `${color}85`);
    gradient.addColorStop(1, `${color}00`);
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius * 4, 0, TWO_PI);
    context.fill();
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, radius, 0, TWO_PI);
    context.fill();
    context.restore();
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.zoom = Math.min(1.9, Math.max(0.72, this.zoom * Math.exp(-event.deltaY * 0.0012)));
    this.panel.querySelector<HTMLElement>('[data-map="zoom"]')!.textContent = `${Math.round(this.zoom * 100)}%`;
    this.refresh();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if ((event.target as HTMLElement).closest('button')) return;
    this.pointerStart = { x: event.clientX, y: event.clientY, offsetX: this.offsetX, offsetY: this.offsetY };
    this.stage.setPointerCapture(event.pointerId);
    this.stage.classList.add('dragging');
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.pointerStart) return;
    this.offsetX = this.pointerStart.offsetX + event.clientX - this.pointerStart.x;
    this.offsetY = this.pointerStart.offsetY + event.clientY - this.pointerStart.y;
    this.refresh();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.pointerStart) return;
    this.pointerStart = undefined;
    if (this.stage.hasPointerCapture(event.pointerId)) this.stage.releasePointerCapture(event.pointerId);
    this.stage.classList.remove('dragging');
  };
}
