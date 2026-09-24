import type { LaunchPresentation } from './LaunchPresentation';
import './launch-screen.css';

const DEFAULT_LAUNCH_COVER = '/images/void-explorer-launch-cover-four-wing-v4.png';

export interface LaunchScreenOptions {
  readonly onStart: (event: MouseEvent | KeyboardEvent) => void;
  readonly coverUrl?: string;
  readonly onOpenDisplaySettings?: () => void;
  readonly isDisplaySettingsOpen?: () => boolean;
}

export interface LaunchReadyOptions {
  readonly renderer?: string;
  readonly audioMuted?: boolean;
}

type LaunchScreenState = 'loading' | 'ready' | 'launching' | 'error';

/**
 * An original, presentation-only doorway into the actual generated universe.
 * Its image is never submitted to the renderer or substituted for gameplay;
 * every destination, count, saved journey, and ship readout is catalog-backed.
 */
export class LaunchScreen {
  readonly root: HTMLElement;

  private readonly onStart: LaunchScreenOptions['onStart'];
  private readonly onOpenDisplaySettings: LaunchScreenOptions['onOpenDisplaySettings'];
  private readonly isDisplaySettingsOpen: LaunchScreenOptions['isDisplaySettingsOpen'];
  private readonly startButton: HTMLButtonElement;
  private readonly displayButton: HTMLButtonElement;
  private currentState: LaunchScreenState = 'loading';
  private disposed = false;

  constructor(parent: HTMLElement, options: LaunchScreenOptions) {
    this.onStart = options.onStart;
    this.onOpenDisplaySettings = options.onOpenDisplaySettings;
    this.isDisplaySettingsOpen = options.isDisplaySettingsOpen;
    this.root = document.createElement('section');
    this.root.className = 'launch-screen';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'launch-screen-title');
    this.root.setAttribute('aria-describedby', 'launch-screen-description');
    this.root.setAttribute('aria-busy', 'true');
    this.root.dataset.launchState = 'loading';
    this.root.innerHTML = `
      <img class="launch-cover" alt="Four-wing AURORA VX-9 exploring a ringed neon world beyond the charted frontier" decoding="async" loading="eager" />
      <span class="launch-cover-shade" aria-hidden="true"></span>
      <span class="launch-cover-grain" aria-hidden="true"></span>

      <header class="launch-topline">
        <div class="launch-program"><span class="launch-signal"></span> DEEP RANGE SURVEY PROGRAM</div>
        <div class="launch-backend"><span>FLIGHT SYSTEM</span><strong data-launch="backend">INITIALIZING</strong></div>
      </header>

      <main class="launch-stage">
        <div class="launch-mark" aria-hidden="true">
          <svg viewBox="0 0 78 78" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle class="launch-mark-orbit" cx="39" cy="39" r="30.5" />
            <circle class="launch-mark-orbit-secondary" cx="39" cy="39" r="22" />
            <path class="launch-mark-vessel" d="M39 13L51.8 52.2L39 44.6L26.2 52.2L39 13Z" />
            <path class="launch-mark-keel" d="M39 44.5V63.5" />
            <path class="launch-mark-axis" d="M7 39H17M61 39H71" />
            <circle class="launch-mark-beacon" cx="39" cy="13" r="2.1" />
          </svg>
          <span>VX / 09</span>
        </div>

        <div class="launch-eyebrow"><span>THE CHARTED FRONTIER</span><i></i><span data-launch="system-name">ACQUIRING SIGNAL</span></div>
        <h1 id="launch-screen-title" class="launch-title"><span>VOID</span><span>EXPLORER</span></h1>
        <p class="launch-subtitle" id="launch-screen-description">A PROCEDURAL UNIVERSE</p>
        <p class="launch-invitation">Every light is somewhere you can go.</p>

        <div class="launch-actions">
          <button class="launch-start" data-launch-action="start" type="button" disabled>
            <span class="launch-start-icon" aria-hidden="true"><i></i></span>
            <span class="launch-start-label" data-launch="action">INITIALIZING EXPEDITION</span>
            <span class="launch-start-arrow" aria-hidden="true">→</span>
          </button>
          <p class="launch-action-hint"><kbd>ENTER</kbd> TO EMBARK <span aria-hidden="true">/</span> HEADPHONES RECOMMENDED</p>
          <button class="launch-display-settings" type="button" data-launch-action="display-settings" hidden>SETTINGS <kbd>G</kbd></button>
        </div>

        <div class="launch-readouts" aria-label="Actual expedition details">
          <div class="launch-readout"><span>REACHABLE SYSTEMS</span><strong data-launch="system-count">—</strong></div>
          <div class="launch-readout"><span>CHART RADIUS</span><strong data-launch="chart-radius">—</strong></div>
          <div class="launch-readout"><span>DISCOVERED</span><strong data-launch="discovered">—</strong></div>
        </div>
      </main>

      <aside class="launch-manifest" aria-label="Assigned spacecraft and actual destination">
        <div class="launch-manifest-heading"><span>EXPEDITION MANIFEST</span><span class="launch-manifest-status" data-launch="status" role="status" aria-live="polite">INITIALIZING</span></div>
        <div class="launch-manifest-row"><span>VESSEL</span><strong data-launch="ship">—</strong></div>
        <div class="launch-manifest-row"><span>WAYPOINT</span><strong data-launch="target">AWAITING TARGET</strong></div>
        <div class="launch-manifest-rule" aria-hidden="true"></div>
        <div class="launch-manifest-frequency" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </aside>

      <footer class="launch-footer">
        <span class="launch-footer-copy">THE UNIVERSE IS REAL. THE JOURNEY IS YOURS.</span>
        <span class="launch-music-credit">“Aphelion” by Scott Buckley · CC BY 4.0 · www.scottbuckley.com.au</span>
      </footer>
      <span class="launch-frame-corners" aria-hidden="true"></span>
    `;

    const cover = this.root.querySelector<HTMLImageElement>('.launch-cover')!;
    cover.src = options.coverUrl ?? DEFAULT_LAUNCH_COVER;
    this.startButton = this.root.querySelector<HTMLButtonElement>('[data-launch-action="start"]')!;
    this.displayButton = this.root.querySelector<HTMLButtonElement>('[data-launch-action="display-settings"]')!;
    this.startButton.addEventListener('click', this.handleClick);
    this.displayButton.addEventListener('click', this.handleDisplaySettingsClick);
    window.addEventListener('keydown', this.handleKeyDown, true);
    parent.append(this.root);
  }

  get active(): boolean {
    return !this.disposed && this.currentState !== 'launching';
  }

  get ready(): boolean {
    return !this.disposed && this.currentState === 'ready';
  }

  setLoading(label = 'INITIALIZING REACHABLE SYSTEMS'): void {
    if (this.disposed || this.currentState === 'launching') return;
    this.setState('loading');
    this.startButton.disabled = true;
    this.displayButton.hidden = true;
    this.value('status').textContent = label;
    this.value('action').textContent = 'INITIALIZING EXPEDITION';
  }

  setReady(presentation: Readonly<LaunchPresentation>, options: LaunchReadyOptions = {}): void {
    if (this.disposed || this.currentState === 'launching') return;
    this.value('system-name').textContent = presentation.systemName.toUpperCase();
    this.value('system-count').textContent = presentation.systemCount.toLocaleString();
    this.value('chart-radius').textContent = `${presentation.chartRadiusLightYears.toLocaleString()} LY`;
    this.value('discovered').textContent = presentation.discoveredSystemCount.toLocaleString();
    this.value('ship').textContent = presentation.shipName;
    this.value('target').textContent = presentation.landedBodyName ?? presentation.targetName ?? 'OPEN EXPEDITION';
    this.value('action').textContent = presentation.actionLabel;
    this.value('status').textContent = presentation.hasSavedJourney ? 'JOURNEY RECOVERED' : 'NAVIGATION READY';
    this.value('backend').textContent = options.renderer
      ? options.renderer.toUpperCase()
      : 'ONLINE';
    this.root.dataset.savedJourney = String(presentation.hasSavedJourney);
    this.root.dataset.launchSystemId = presentation.systemId;
    this.root.dataset.audioMuted = String(options.audioMuted === true);
    this.root.setAttribute('aria-busy', 'false');
    this.setState('ready');
    this.startButton.disabled = false;
    this.displayButton.hidden = !this.onOpenDisplaySettings;
    this.startButton.focus({ preventScroll: true });
  }

  setError(message: string): void {
    if (this.disposed || this.currentState === 'launching') return;
    this.setState('error');
    this.startButton.disabled = true;
    this.displayButton.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.value('status').textContent = 'INITIALIZATION FAILED';
    this.value('action').textContent = message || 'EXPEDITION UNAVAILABLE';
  }

  /** Release both focus and pointer ownership synchronously before live flight begins. */
  dismiss(): void {
    if (this.disposed || this.currentState === 'launching') return;
    this.currentState = 'launching';
    this.root.dataset.launchState = 'launching';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.inert = true;
    this.root.style.pointerEvents = 'none';
    this.startButton.disabled = true;
    this.displayButton.disabled = true;
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    window.removeEventListener('keydown', this.handleKeyDown, true);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.root.remove();
      return;
    }
    this.root.addEventListener('transitionend', this.removeDismissedScreen, { once: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown, true);
    this.startButton.removeEventListener('click', this.handleClick);
    this.displayButton.removeEventListener('click', this.handleDisplaySettingsClick);
    this.root.removeEventListener('transitionend', this.removeDismissedScreen);
    this.root.remove();
  }

  private setState(state: LaunchScreenState): void {
    this.currentState = state;
    this.root.dataset.launchState = state;
  }

  private value(name: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(`[data-launch="${name}"]`)!;
  }

  private readonly removeDismissedScreen = (): void => {
    if (this.currentState === 'launching') this.root.remove();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    if (!this.ready) return;
    event.preventDefault();
    event.stopPropagation();
    // Root invokes the actual AudioContext unlock immediately in this trusted
    // click stack; never defer it behind an animation or microtask.
    this.onStart(event);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (this.isDisplaySettingsOpen?.() || (event.target instanceof Element && event.target.closest('[data-display-settings]'))) {
      return;
    }
    if (event.key === 'Tab') return;
    if (event.code === 'KeyG' && this.ready && this.onOpenDisplaySettings && !event.repeat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.onOpenDisplaySettings();
      return;
    }
    if (event.target === this.displayButton) {
      if (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.ready && !event.repeat) this.onOpenDisplaySettings?.();
        return;
      }
    }
    event.stopImmediatePropagation();
    if (event.code !== 'Enter' && event.code !== 'NumpadEnter' && event.code !== 'Space') {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (this.ready && !event.repeat) {
      // Calling the real start action inside the trusted keyboard stack avoids
      // synthetic button.click() events and preserves browser autoplay rights.
      this.onStart(event);
    }
  };

  private readonly handleDisplaySettingsClick = (event: MouseEvent): void => {
    if (!this.ready || !this.onOpenDisplaySettings) return;
    event.preventDefault();
    event.stopPropagation();
    this.onOpenDisplaySettings();
  };
}
