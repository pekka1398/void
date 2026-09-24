import { AURORA_ACTIVE_ASSET } from '../render/ship/AuroraAsset';
import type { CockpitRadarContact, CockpitRadarSnapshot } from './CockpitRadar';
import { projectHolographicRadar } from './HolographicRadar';
import type { HudSnapshot } from './Hud';


const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const RADAR_PROJECTION = {
  centerX: 120,
  centerY: 94,
  horizontalRadius: 88,
  planeDepthRadius: 31,
  heightRadius: 39,
} as const;

/** Unformatted values from the same physical flight state as the external HUD. */
export interface CockpitFlightTelemetry {
  speedMetersPerSecond: number;
  throttle: number;
  altitudeMeters: number;
  targetDistanceMeters?: number;
  landed?: boolean;
}

interface RadarContactElements {
  marker: SVGGElement;
  stem: SVGLineElement;
  foot: SVGCircleElement;
  transform: string;
  footX: string;
  footY: string;
  distance: string;
  elevation: string;
  height: string;
  color: string;
  selected: boolean;
  behind: boolean;
  clipped: boolean;
}

/**
 * Native-resolution AURORA flight instruments over the actual camera view.
 *
 * The windshield and cowling are real camera-local geometry. This transparent
 * DOM layer supplies only the readable instrument faces; every number and
 * radar contact and vertical hologram stem comes from the same live
 * simulation as the external HUD, without another scene or render pass.
 */
export class CockpitOverlay {
  readonly root: HTMLDivElement;

  private readonly instruments = new Map<string, HTMLElement>();
  private readonly contacts = new Map<string, RadarContactElements>();
  private readonly radarContacts: SVGGElement;
  private readonly presentationValues = new Map<string, string>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'aurora-cockpit cockpit-overlay';
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = `
      <div class="cockpit-side-rail cockpit-side-rail-port" aria-hidden="true"></div>
      <div class="cockpit-side-rail cockpit-side-rail-starboard" aria-hidden="true"></div>
      <div class="cockpit-boresight" data-cockpit="boresight" aria-hidden="true">
        <span class="cockpit-boresight-ring"></span>
        <span class="cockpit-boresight-center"></span>
      </div>

      <section class="cockpit-console" aria-label="${AURORA_ACTIVE_ASSET.name} flight instruments">
        <div class="cockpit-console-spine" aria-hidden="true"></div>
        <div class="cockpit-console-apron" aria-hidden="true"></div>

        <article class="cockpit-screen cockpit-screen-navigation" aria-label="Actual navigation target">
          <header class="cockpit-screen-heading">
            <span class="cockpit-index">01</span>
            <span>ASTROMETRIC LOCK</span>
            <span class="cockpit-signal cockpit-signal-cyan"></span>
          </header>
          <div class="cockpit-display-body">
            <span class="cockpit-caption cockpit-main-caption">SELECTED DESTINATION</span>
            <strong class="cockpit-target-name" data-cockpit="target">FREE FLIGHT</strong>
            <span class="cockpit-secondary" data-cockpit="target-kind">WAYPOINT</span>
            <div class="cockpit-display-divider" aria-hidden="true"></div>
            <div class="cockpit-metric-row">
              <span class="cockpit-caption">TRUE RANGE</span>
              <strong class="cockpit-readout-cyan" data-cockpit="distance">—</strong>
            </div>
            <div class="cockpit-metric-row cockpit-metric-row-quiet">
              <span class="cockpit-caption">ARRIVAL</span>
              <strong data-cockpit="eta">—</strong>
            </div>
          </div>
        </article>

        <article class="cockpit-screen cockpit-screen-drive" aria-label="Actual flight speed and thrust">
          <header class="cockpit-screen-heading">
            <span class="cockpit-index">02</span>
            <span>VECTOR PROPULSION</span>
          </header>
          <div class="cockpit-display-body">
            <span class="cockpit-caption cockpit-main-caption">TRUE VELOCITY</span>
            <strong class="cockpit-major-readout" data-cockpit="speed">0 m/s</strong>
            <div class="cockpit-meter-heading">
              <span class="cockpit-caption">THRUST COMMAND</span>
              <strong class="cockpit-meter-value" data-cockpit="throttle">0%</strong>
            </div>
            <div class="cockpit-live-meter cockpit-throttle-meter" data-cockpit="throttle-meter"
              role="meter" aria-label="Actual throttle command" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <span class="cockpit-live-meter-fill"></span>
            </div>
            <div class="cockpit-metric-row">
              <span class="cockpit-caption">FLIGHT PROFILE</span>
              <strong class="cockpit-mode-readout" data-cockpit="mode">CRUISE</strong>
            </div>
          </div>
        </article>

        <article class="cockpit-radar-housing" aria-label="Actual three-dimensional local celestial contacts">
          <header class="cockpit-radar-heading">
            <span class="cockpit-radar-heading-title"><span class="cockpit-index">03</span> HOLOGRAPHIC ORRERY</span>
            <span class="cockpit-radar-count" data-cockpit="contact-count">00</span>
          </header>
          <svg class="cockpit-radar" data-cockpit="radar" viewBox="0 0 240 160"
            role="img" aria-label="Live three-dimensional stars, planets, and moons">
            <defs>
              <radialGradient id="aurora-cockpit-hologram-plane" cx="50%" cy="50%" r="56%">
                <stop offset="0%" stop-color="#16f5e4" stop-opacity=".18"></stop>
                <stop offset="58%" stop-color="#0986aa" stop-opacity=".1"></stop>
                <stop offset="100%" stop-color="#041326" stop-opacity=".04"></stop>
              </radialGradient>
            </defs>
            <path class="cockpit-radar-dome" d="M 32 94 C 43 29 197 29 208 94"></path>
            <path class="cockpit-radar-meridian" d="M 54 80 C 96 55 144 55 186 80 M 81 66 C 107 52 133 52 159 66"></path>
            <ellipse class="cockpit-radar-plane" cx="120" cy="94" rx="88" ry="31"></ellipse>
            <ellipse class="cockpit-radar-ring" cx="120" cy="94" rx="88" ry="31"></ellipse>
            <ellipse class="cockpit-radar-ring cockpit-radar-ring-inner" cx="120" cy="94" rx="65" ry="23"></ellipse>
            <ellipse class="cockpit-radar-ring cockpit-radar-ring-inner" cx="120" cy="94" rx="43" ry="15"></ellipse>
            <ellipse class="cockpit-radar-ring cockpit-radar-ring-center" cx="120" cy="94" rx="21" ry="7.5"></ellipse>
            <path class="cockpit-radar-axis" d="M 32 94 H 208 M 120 63 V 125 M 58 72 L 182 116 M 182 72 L 58 116"></path>
            <path class="cockpit-radar-altitude-axis" d="M 120 49 V 94"></path>
            <path class="cockpit-radar-heading-tick" d="M 116 61 L 120 55 L 124 61"></path>
            <g data-cockpit="radar-blips"></g>
            <path class="cockpit-radar-ship" d="M 120 88 L 125 98 L 120 96 L 115 98 Z"></path>
            <path class="cockpit-radar-projector" d="M 92 138 H 148 M 103 141 H 137"></path>
          </svg>
          <footer class="cockpit-radar-footer">
            <span>LIVE ORBITAL POSES</span>
            <span>SIGNED ELEVATION</span>
          </footer>
        </article>

        <article class="cockpit-screen cockpit-screen-terrain" aria-label="Actual surface clearance">
          <header class="cockpit-screen-heading">
            <span class="cockpit-index">04</span>
            <span>SURFACE TELEMETRY</span>
          </header>
          <div class="cockpit-display-body">
            <span class="cockpit-caption cockpit-main-caption">TRUE CLEARANCE</span>
            <strong class="cockpit-major-readout cockpit-altitude" data-cockpit="altitude">—</strong>
            <div class="cockpit-meter-heading">
              <span class="cockpit-caption">SURFACE ENVELOPE</span>
              <strong class="cockpit-clearance-state" data-cockpit="clearance-state">CLEAR</strong>
            </div>
            <div class="cockpit-live-meter cockpit-altitude-meter" data-cockpit="altitude-meter"
              role="meter" aria-label="Actual surface clearance" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
              <span class="cockpit-live-meter-fill"></span>
            </div>
            <div class="cockpit-metric-row">
              <span class="cockpit-caption">TRUE BEARING</span>
              <strong class="cockpit-readout-cyan" data-cockpit="heading">000°</strong>
            </div>
          </div>
        </article>

        <article class="cockpit-screen cockpit-screen-system" aria-label="Actual current star system">
          <header class="cockpit-screen-heading">
            <span class="cockpit-index">05</span>
            <span>STELLAR CARTOGRAPHY</span>
            <span class="cockpit-signal cockpit-signal-amber"></span>
          </header>
          <div class="cockpit-display-body">
            <span class="cockpit-caption cockpit-main-caption">CURRENT STELLAR FRAME</span>
            <strong class="cockpit-system-name" data-cockpit="system">ACQUIRING</strong>
            <span class="cockpit-secondary" data-cockpit="system-kind">STELLAR SYSTEM</span>
            <div class="cockpit-display-divider" aria-hidden="true"></div>
            <div class="cockpit-metric-row">
              <span class="cockpit-caption">REACHABLE</span>
              <strong data-cockpit="catalog-count">—</strong>
            </div>
            <div class="cockpit-metric-row cockpit-metric-row-quiet">
              <span class="cockpit-caption">DISCOVERED</span>
              <strong data-cockpit="discovered">—</strong>
            </div>
          </div>
        </article>

        <div class="cockpit-console-legend" aria-hidden="true">
          <span>${AURORA_ACTIVE_ASSET.name} <b>·</b> FLIGHT INSTRUMENTS ONLINE</span>
          <span><b>V</b> EXTERNAL VIEW</span>
        </div>
      </section>
    `;

    for (const instrument of this.root.querySelectorAll<HTMLElement>('[data-cockpit]')) {
      const key = instrument.dataset.cockpit;
      if (key) this.instruments.set(key, instrument);
    }

    const contacts = this.root.querySelector<SVGGElement>('[data-cockpit="radar-blips"]');
    if (!contacts) throw new Error('AURORA cockpit radar has no real-contact layer.');
    this.radarContacts = contacts;
    parent.append(this.root);
  }

  get active(): boolean {
    return !this.root.hidden;
  }

  setActive(active: boolean): void {
    this.root.hidden = !active;
    this.root.setAttribute('aria-hidden', String(!active));
    this.root.classList.toggle('active', active);
    if (!active) this.clearRadar();
  }

  update(
    snapshot: HudSnapshot,
    radar?: CockpitRadarSnapshot,
    telemetry?: CockpitFlightTelemetry,
  ): void {
    this.setText('target', snapshot.targetName.toUpperCase());
    this.setText('target-kind', snapshot.targetKind.toUpperCase());
    this.setText('distance', snapshot.distance);
    this.setText('eta', snapshot.eta);
    this.setText('speed', snapshot.speed);
    this.setText('altitude', snapshot.altitude);
    this.setText('system', snapshot.systemName.toUpperCase());
    this.setText('system-kind', `${snapshot.systemKind.toUpperCase()} SYSTEM`);
    this.setText('catalog-count', snapshot.starCount.toLocaleString());
    this.setText('discovered', snapshot.discovered.toLocaleString());

    const heading = ((Math.round(snapshot.heading) % 360) + 360) % 360;
    this.setText('heading', `${heading.toString().padStart(3, '0')}°`);
    this.setPresentationValue('--cockpit-heading-turn', `${heading}deg`);

    const mode = snapshot.mode.toUpperCase();
    const modeClass = snapshot.mode.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const modeReadout = this.instruments.get('mode');
    if (modeReadout) {
      if (modeReadout.textContent !== mode) modeReadout.textContent = mode;
      const className = `cockpit-mode-readout cockpit-mode-${modeClass}`;
      if (modeReadout.className !== className) modeReadout.className = className;
    }

    if (telemetry) this.updateFlightTelemetry(telemetry);
    // Formatted HUD instruments and true-frame radar intentionally use
    // independent cadences. An omitted scope never clears live contacts.
    if (radar) this.updateRadarFrame(radar, telemetry);
  }

  /** Refresh the same-epoch 3D scope once per actual rendered cockpit frame. */
  updateRadarFrame(snapshot: CockpitRadarSnapshot, telemetry?: CockpitFlightTelemetry): void {
    if (!this.active) return;
    if (telemetry) this.updateFlightTelemetry(telemetry);

    const projected = projectHolographicRadar(snapshot, RADAR_PROJECTION);
    const retained = new Set<string>();
    this.setText('contact-count', snapshot.contacts.length.toString().padStart(2, '0'));
    this.setData(this.root, 'radarSystem', snapshot.systemId);
    this.setData(this.root, 'radarEpoch', String(snapshot.timeSeconds));
    this.setData(this.root, 'radarRange', String(snapshot.rangeMeters));

    for (let index = 0; index < projected.contacts.length; index += 1) {
      const projection = projected.contacts[index]!;
      const contact = projection.source;
      retained.add(contact.id);

      let elements = this.contacts.get(contact.id);
      if (!elements) {
        elements = this.createContact(contact);
        this.contacts.set(contact.id, elements);
      }

      const currentPosition = this.radarContacts.children[index];
      if (currentPosition !== elements.marker) {
        this.radarContacts.insertBefore(elements.marker, currentPosition ?? null);
      }

      const distance = String(contact.distanceMeters);
      if (elements.distance !== distance) {
        elements.distance = distance;
        elements.marker.dataset.radarDistance = distance;
      }

      const elevation = String(contact.elevationRadians);
      if (elements.elevation !== elevation) {
        elements.elevation = elevation;
        elements.marker.dataset.radarElevation = elevation;
      }

      const height = String(projection.height);
      if (elements.height !== height) {
        elements.height = height;
        elements.marker.dataset.radarHeight = height;
      }

      const transform = `translate(${projection.x.toFixed(2)} ${projection.y.toFixed(2)})`;
      if (elements.transform !== transform) {
        elements.transform = transform;
        elements.marker.setAttribute('transform', transform);
      }

      const footX = (projection.planeX - projection.x).toFixed(2);
      const footY = (projection.planeY - projection.y).toFixed(2);
      if (elements.footX !== footX) {
        elements.footX = footX;
        elements.stem.setAttribute('x2', footX);
        elements.foot.setAttribute('cx', footX);
      }
      if (elements.footY !== footY) {
        elements.footY = footY;
        elements.stem.setAttribute('y2', footY);
        elements.foot.setAttribute('cy', footY);
      }

      if (elements.color !== contact.color) {
        elements.color = contact.color;
        elements.marker.style.setProperty('--radar-contact-color', contact.color);
      }
      if (elements.selected !== contact.selected) {
        elements.selected = contact.selected;
        elements.marker.dataset.selected = String(contact.selected);
        elements.marker.classList.toggle('cockpit-radar-contact-selected', contact.selected);
      }
      if (elements.behind !== contact.behind) {
        elements.behind = contact.behind;
        elements.marker.dataset.behind = String(contact.behind);
        elements.marker.classList.toggle('cockpit-radar-contact-behind', contact.behind);
      }
      if (elements.clipped !== contact.clipped) {
        elements.clipped = contact.clipped;
        elements.marker.dataset.clipped = String(contact.clipped);
        elements.marker.classList.toggle('cockpit-radar-contact-clipped', contact.clipped);
      }
    }

    for (const [id, elements] of this.contacts) {
      if (retained.has(id)) continue;
      elements.marker.remove();
      this.contacts.delete(id);
    }
  }

  dispose(): void {
    this.contacts.clear();
    this.instruments.clear();
    this.presentationValues.clear();
    this.root.remove();
  }

  private updateFlightTelemetry(telemetry: CockpitFlightTelemetry): void {
    const throttle = Number.isFinite(telemetry.throttle)
      ? Math.max(0, Math.min(1, telemetry.throttle))
      : 0;
    const throttlePercent = Math.round(throttle * 100);
    this.setText('throttle', `${throttlePercent}%`);
    this.setPresentationValue('--cockpit-throttle-fill', `${throttlePercent}%`);
    this.setMeterValue('throttle-meter', throttlePercent);
    this.setData(this.root, 'cockpitThrottle', String(throttle));

    if (Number.isFinite(telemetry.speedMetersPerSecond)) {
      this.setData(this.root, 'cockpitSpeed', String(telemetry.speedMetersPerSecond));
    }

    if (Number.isFinite(telemetry.altitudeMeters)) {
      const altitude = Math.max(0, telemetry.altitudeMeters);
      const clearancePercent = Math.round(
        Math.min(1, Math.log1p(altitude) / Math.log1p(150_000)) * 100,
      );
      this.setPresentationValue('--cockpit-clearance-fill', `${clearancePercent}%`);
      this.setMeterValue('altitude-meter', clearancePercent);
      this.setData(this.root, 'cockpitAltitudeMeters', String(altitude));

      const clearanceState = telemetry.landed
        ? 'LANDED'
        : altitude < 180
          ? 'PROXIMITY'
          : altitude < 2_500
            ? 'APPROACH'
            : 'CLEAR';
      this.setText('clearance-state', clearanceState);
      this.setData(this.root, 'clearance', clearanceState.toLowerCase());
    }

    if (Number.isFinite(telemetry.targetDistanceMeters)) {
      this.setData(this.root, 'cockpitTargetMeters', String(telemetry.targetDistanceMeters));
    } else if (this.root.dataset.cockpitTargetMeters !== undefined) {
      delete this.root.dataset.cockpitTargetMeters;
    }
  }

  private setText(name: string, value: string): void {
    const instrument = this.instruments.get(name);
    if (instrument && instrument.textContent !== value) instrument.textContent = value;
  }

  private setPresentationValue(name: string, value: string): void {
    if (this.presentationValues.get(name) === value) return;
    this.presentationValues.set(name, value);
    this.root.style.setProperty(name, value);
  }

  private setMeterValue(name: string, value: number): void {
    const meter = this.instruments.get(name);
    if (!meter) return;
    const formatted = String(value);
    if (meter.getAttribute('aria-valuenow') !== formatted) {
      meter.setAttribute('aria-valuenow', formatted);
    }
  }

  private setData(element: HTMLElement, name: string, value: string): void {
    if (element.dataset[name] !== value) element.dataset[name] = value;
  }

  private createContact(contact: CockpitRadarContact): RadarContactElements {
    const marker = document.createElementNS(SVG_NAMESPACE, 'g');
    marker.classList.add('cockpit-radar-contact', `cockpit-radar-contact-${contact.kind}`);

    marker.dataset.radarId = contact.id;
    marker.dataset.radarKind = contact.kind;
    marker.dataset.selected = String(!contact.selected);
    marker.dataset.behind = String(!contact.behind);
    marker.dataset.clipped = String(!contact.clipped);
    marker.setAttribute('aria-label', contact.name);

    const stem = document.createElementNS(SVG_NAMESPACE, 'line');
    stem.classList.add('cockpit-radar-contact-stem');
    stem.setAttribute('x1', '0');
    stem.setAttribute('y1', '0');
    marker.append(stem);

    const foot = document.createElementNS(SVG_NAMESPACE, 'circle');
    foot.classList.add('cockpit-radar-contact-foot');
    foot.setAttribute('r', contact.kind === 'star' ? '2.1' : '1.55');
    marker.append(foot);

    const halo = document.createElementNS(SVG_NAMESPACE, 'circle');
    halo.classList.add('cockpit-radar-contact-halo');
    halo.setAttribute('r', contact.kind === 'star' ? '6.8' : '5.1');
    marker.append(halo);

    const dot = document.createElementNS(SVG_NAMESPACE, 'circle');
    dot.classList.add('cockpit-radar-contact-core');
    dot.setAttribute('r', contact.kind === 'star' ? '2.9' : contact.kind === 'moon' ? '1.6' : '2.15');
    marker.append(dot);

    const selection = document.createElementNS(SVG_NAMESPACE, 'path');
    selection.classList.add('cockpit-radar-contact-selection');
    selection.setAttribute(
      'd',
      'M -6 -4 V -6 H -4 M 4 -6 H 6 V -4 M 6 4 V 6 H 4 M -4 6 H -6 V 4',
    );
    marker.append(selection);

    return {
      marker,
      stem,
      foot,
      transform: '',
      footX: '',
      footY: '',
      distance: '',
      elevation: '',
      height: '',
      color: '',
      selected: !contact.selected,
      behind: !contact.behind,
      clipped: !contact.clipped,
    };
  }

  private clearRadar(): void {
    if (this.contacts.size === 0) return;
    for (const { marker } of this.contacts.values()) marker.remove();
    this.contacts.clear();
    this.setText('contact-count', '00');
    delete this.root.dataset.radarSystem;
    delete this.root.dataset.radarEpoch;
    delete this.root.dataset.radarRange;
  }
}
