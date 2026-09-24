import { StarMap, type MapEntry, type NavigationTargetKind, type StarMapLayout, type StarMapStar } from './StarMap';

export type { MapEntry, NavigationTargetKind, StarMapLayout, StarMapStar } from './StarMap';

export interface HudSnapshot {
  systemName: string;
  systemKind: string;
  targetName: string;
  targetKind: string;
  distance: string;
  eta: string;
  speed: string;
  mode: string;
  altitude: string;
  heading: number;
  starCount: number;
  fps: number;
  discovered: number;
  targetId?: string;
}

export interface WorldTarget {
  id: string;
  name: string;
  kind: NavigationTargetKind;
  x: number;
  y: number;
  visible: boolean;
  distance: string;
  label?: string;
  selected?: boolean;
  color?: string;
  radius?: number;
  offscreen?: boolean;
  bearingRadians?: number;
  description?: string;
}

export function clampWorldTargetRadius(radius: number | undefined, selected: boolean): number {
  return Math.max(18, Math.min(selected ? 70 : 40, radius ?? 22));
}

export class Hud {
  readonly root: HTMLDivElement;
  onSelect: ((id: string, kind: NavigationTargetKind) => void) | undefined;
  onApproach: ((id: string, kind: NavigationTargetKind) => void) | undefined;
  onInspect: ((id: string, kind: NavigationTargetKind) => void) | undefined;
  onOpenPauseMenu: (() => void) | undefined;

  private readonly map: StarMap;
  private readonly markers = new Map<string, HTMLButtonElement>();
  private toastTimeout: number | undefined;
  private selectedTargetId: string | undefined;
  private hoveredTargetId: string | undefined;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <header class="hud-top">
        <div class="brand">
          <span class="brand-title">VOID EXPLORER</span>
          <span class="brand-sub"><span class="signal-dot"></span> LONG RANGE EXPLORATION VESSEL</span>
        </div>
        <div class="system-tag">
          <span class="system-tag-label">CURRENT LOCATION</span>
          <strong data-hud="system"></strong>
          <span data-hud="system-kind"></span>
        </div>
      </header>

      <div class="compass" aria-label="Current heading">
        <span class="compass-cardinal">N</span>
        <span class="compass-line"></span>
        <span class="compass-bearing" data-hud="heading">000°</span>
        <span class="compass-line"></span>
        <span class="compass-cardinal">E</span>
      </div>

      <div class="world-targets" aria-label="Visible destinations"></div>

      <div class="reticle" aria-hidden="true">
        <span class="reticle-ring"></span>
        <span class="reticle-center"></span>
        <span class="reticle-arm reticle-arm-top"></span>
        <span class="reticle-arm reticle-arm-bottom"></span>
        <span class="reticle-arm reticle-arm-left"></span>
        <span class="reticle-arm reticle-arm-right"></span>
      </div>

      <section class="target" aria-label="Current waypoint">
        <div class="target-eyebrow"><span class="target-signal"></span><span class="target-label">NAVIGATION LOCK</span><span class="target-status">LIVE</span></div>
        <div class="target-name" data-hud="target">ACQUIRING TARGET</div>
        <div class="target-kind" data-hud="target-kind">WAYPOINT</div>
        <div class="target-readout"><span class="target-distance" data-hud="distance">—</span><span class="target-distance-caption">RANGE</span></div>
        <div class="target-detail"><span>ARRIVAL</span><strong data-hud="eta">—</strong></div>
        <span class="target-corner target-corner-top"></span><span class="target-corner target-corner-bottom"></span>
      </section>

      <footer class="bottom">
        <div class="telemetry">
          <div class="cluster"><div class="cluster-label">VELOCITY</div><div class="cluster-value" data-hud="speed">0 m/s</div></div>
          <div class="cluster cluster-mode"><div class="cluster-label">FLIGHT PROFILE</div><div class="cluster-value mode-value" data-hud="mode">CRUISE</div></div>
          <div class="cluster"><div class="cluster-label">SURFACE ALTITUDE</div><div class="cluster-value" data-hud="altitude">—</div></div>
        </div>
      </footer>

      <button class="hud-menu" type="button" data-hud-action="pause" aria-label="Open pause menu"><kbd>ESC</kbd><span>MENU</span></button>

      <div class="toast" role="status" aria-live="polite"></div>

      <aside class="map-panel" aria-label="Interactive star system and galaxy navigation" aria-hidden="true" data-view="system">
        <header class="map-header">
          <div class="map-heading"><span class="map-kicker">NAVIGATION COMPUTER // ASTROMETRIC SURVEY</span><div class="map-title">STAR CHART</div><div class="map-summary" data-hud="map-summary"></div></div>
          <nav class="map-tabs" aria-label="Map view" role="tablist">
            <button class="map-tab active" type="button" data-map-view="system" role="tab" aria-selected="true">SYSTEM</button>
            <button class="map-tab" type="button" data-map-view="galaxy" role="tab" aria-selected="false">GALAXY</button>
          </nav>
          <button class="map-close" type="button" aria-label="Close star chart"><span></span><span></span></button>
        </header>

        <section class="map-stage" aria-label="Interactive celestial chart">
          <canvas class="map-canvas" aria-hidden="true"></canvas>
          <div class="map-nodes"></div>
          <div class="map-center-caption"><span data-map="system-name">CURRENT SYSTEM</span><span data-map="system-kind">STELLAR SYSTEM</span></div>
          <div class="map-chart-label" data-map="chart-label">ORBITAL SURVEY</div>
          <div class="map-orientation"><span>GALACTIC NORTH</span><span>⌁</span></div>

          <article class="map-detail" aria-live="polite">
            <div class="map-detail-status" data-map="detail-status">NAVIGATION SOLUTION AVAILABLE</div>
            <div class="map-detail-name" data-map="detail-name">DESTINATION</div>
            <div class="map-detail-kind" data-map="detail-kind"></div>
            <div class="map-detail-description" data-map="detail-description"></div>
            <div class="map-detail-range" hidden><span>ACTUAL RANGE</span><strong data-map="detail-distance"></strong></div>
            <div class="map-detail-actions">
              <button type="button" data-map-action="lock">LOCK WAYPOINT</button>
              <button type="button" data-map-action="approach">APPROACH</button>
              <button type="button" data-map-action="inspect" aria-label="Inspect destination">INFO</button>
            </div>
          </article>
        </section>

        <footer class="map-footer"><span><span class="map-legend-dot"></span> VERIFIED DESTINATIONS ONLY</span><span>DRAG TO PAN <span class="help-separator">/</span> SCROLL TO ZOOM</span><button class="map-focus" type="button">RECENTER <span data-map="zoom">100%</span></button></footer>
      </aside>
    `;
    parent.append(this.root);
    this.root.querySelector<HTMLButtonElement>('[data-hud-action="pause"]')!
      .addEventListener('click', this.onPauseMenuClick);

    this.map = new StarMap(this.root.querySelector<HTMLElement>('.map-panel')!, {
      onSelect: (id, kind) => {
        this.setTargetLock(id);
        this.onSelect?.(id, kind);
      },
      onApproach: (id, kind) => this.onApproach?.(id, kind),
      onInspect: (id, kind) => this.onInspect?.(id, kind),
      onClose: () => this.map.close(),
    });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);
  }

  get mapOpen(): boolean {
    return this.map.isOpen;
  }

  isMapOpen(): boolean {
    return this.map.isOpen;
  }

  setCockpitMode(active: boolean): void {
    this.root.classList.toggle('cockpit-mode', active);
    this.root.dataset.flightView = active ? 'cockpit' : 'chase';
  }

  setOnFootMode(active: boolean): void {
    this.root.classList.toggle('on-foot-mode', active);
    const label = this.root.querySelector<HTMLElement>('.cluster-mode .cluster-label');
    if (label) label.textContent = active ? 'SURFACE PROFILE' : 'FLIGHT PROFILE';
  }

  update(snapshot: HudSnapshot): void {
    this.element('system').textContent = snapshot.systemName.toUpperCase();
    this.element('system-kind').textContent = `${snapshot.systemKind.toUpperCase()} SYSTEM · ${snapshot.starCount.toLocaleString()} CHARTED`;
    this.element('target').textContent = snapshot.targetName.toUpperCase();
    this.element('target-kind').textContent = snapshot.targetKind.toUpperCase();
    this.element('distance').textContent = snapshot.distance;
    this.element('eta').textContent = snapshot.eta;
    this.element('speed').textContent = snapshot.speed;
    this.element('altitude').textContent = snapshot.altitude;

    const heading = ((Math.round(snapshot.heading) % 360) + 360) % 360;
    this.element('heading').textContent = `${heading.toString().padStart(3, '0')}°`;

    const mode = this.element('mode');
    const modeClass = snapshot.mode.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    mode.textContent = snapshot.mode.toUpperCase();
    mode.className = `cluster-value mode-value mode-${modeClass}`;

    this.element('map-summary').textContent = `${snapshot.discovered} DISCOVERED · ${snapshot.starCount.toLocaleString()} REACHABLE SYSTEMS`;
    this.map.setChartedCount(snapshot.starCount);
    this.map.setSystem(snapshot.systemName, snapshot.systemKind);
    if (snapshot.targetId !== undefined) this.setTargetLock(snapshot.targetId);
  }

  setMapEntries(entries: MapEntry[]): void {
    this.map.setEntries(entries);
  }

  setMapLayout(layout: StarMapLayout): void {
    this.map.setLayout(layout);
    if (layout.activeTargetId !== undefined) this.setTargetLock(layout.activeTargetId);
  }

  setTargetLock(id: string | undefined): void {
    if (id === this.selectedTargetId) return;
    this.selectedTargetId = id;
    this.map.setTarget(id);
    this.root.classList.toggle('target-locked', Boolean(id));
    for (const [markerId, marker] of this.markers) marker.classList.toggle('selected', markerId === id);
  }

  setWorldTargets(targets: WorldTarget[]): void {
    const layer = this.root.querySelector<HTMLElement>('.world-targets')!;
    const retained = new Set<string>();

    for (const target of targets) {
      if (!target.visible && !(target.selected && target.offscreen)) continue;
      retained.add(target.id);
      let marker = this.markers.get(target.id);

      if (!marker) {
        marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'world-target';
        marker.innerHTML = '<span class="world-target-brackets"></span><span class="world-target-offscreen-arrow"></span><span class="world-target-copy"><span class="world-target-name"></span><span class="world-target-type"></span><span class="world-target-distance"></span></span>';
        this.markers.set(target.id, marker);
        layer.append(marker);
        marker.addEventListener('click', (event) => {
          event.stopPropagation();
          const kind = marker!.dataset.kind as NavigationTargetKind;
          this.setTargetLock(target.id);
          this.onSelect?.(target.id, kind);
        });
        marker.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          this.onApproach?.(target.id, marker!.dataset.kind as NavigationTargetKind);
        });
        marker.addEventListener('mouseenter', () => this.setHoverTarget(target.id));
        marker.addEventListener('mouseleave', () => this.setHoverTarget(undefined));
      }

      marker.dataset.id = target.id;
      marker.dataset.kind = target.kind;
      marker.style.left = `${target.x}px`;
      marker.style.top = `${target.y}px`;
      marker.style.setProperty('--target-color', target.color ?? '#00eaff');
      const selected = target.selected === true || this.selectedTargetId === target.id;
      marker.style.setProperty('--target-radius', `${clampWorldTargetRadius(target.radius, selected)}px`);
      marker.style.setProperty('--target-bearing', `${target.bearingRadians ?? 0}rad`);
      marker.classList.toggle('selected', selected);
      marker.classList.toggle('offscreen', target.offscreen === true);
      marker.classList.toggle('hovered', this.hoveredTargetId === target.id);
      marker.setAttribute('aria-label', `${target.name}${target.label ? `, ${target.label}` : ''}, ${target.distance}${target.description ? `, ${target.description}` : ''}`);
      marker.querySelector<HTMLElement>('.world-target-name')!.textContent = target.name;
      const classification = marker.querySelector<HTMLElement>('.world-target-type')!;
      const showClassification = Boolean(target.label && target.label.toLowerCase() !== target.name.toLowerCase());
      classification.textContent = showClassification ? target.label! : '';
      classification.hidden = !showClassification;
      marker.querySelector<HTMLElement>('.world-target-distance')!.textContent = target.distance;
    }

    for (const [id, marker] of this.markers) {
      if (retained.has(id)) continue;
      marker.remove();
      this.markers.delete(id);
    }
  }

  setHoverTarget(target?: string | WorldTarget): void {
    const id = typeof target === 'string' ? target : target?.id;
    if (id === this.hoveredTargetId) return;
    this.hoveredTargetId = id;
    for (const [markerId, marker] of this.markers) marker.classList.toggle('hovered', markerId === id);
  }

  toggleMap(): void {
    this.map.toggle();
  }

  notify(message: string): void {
    const toast = this.root.querySelector<HTMLElement>('.toast')!;
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => toast.classList.remove('visible'), 2200);
  }

  dispose(): void {
    window.clearTimeout(this.toastTimeout);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.root.querySelector<HTMLButtonElement>('[data-hud-action="pause"]')!
      .removeEventListener('click', this.onPauseMenuClick);
    this.map.dispose();
    this.markers.clear();
    this.root.remove();
  }

  private element(name: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(`[data-hud="${name}"]`)!;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.map.isOpen) return;
    event.preventDefault();
    this.map.close();
  };

  private readonly onResize = (): void => {
    if (!this.map.isOpen) return;
    this.map.close();
    this.map.open();
  };

  private readonly onPauseMenuClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.onOpenPauseMenu?.();
  };
}
