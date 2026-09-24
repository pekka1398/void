import { PAUSE_CONTROLS, type PauseControlsMode, type PauseControlsSection } from './PauseControls';
import './pause-menu.css';

export interface PauseMenuContext {
  readonly systemName: string;
  readonly location?: string;
  readonly mode?: string;
}

export interface PauseMenuOptions {
  /** The caller owns unpausing and any trusted-gesture pointer-lock request. */
  readonly onResume: (event: Event) => void;
  readonly onSettings: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}

type PauseMenuView = 'home' | 'controls';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function controlsMarkup(section: PauseControlsSection): string {
  return `<section class="pause-menu-control-panel" role="tabpanel" tabindex="0"
    id="pause-controls-panel-${section.id}" aria-labelledby="pause-controls-tab-${section.id}"
    data-pause-control-panel="${section.id}"${section.id === 'flight' ? '' : ' hidden'}>
    <p class="pause-menu-controls-description">${escapeHtml(section.description)}</p>
    ${section.groups.map((group) => `<section class="pause-menu-control-group">
      <h3>${escapeHtml(group.title)}</h3>
      <dl>${group.rows.map((row) => `<div class="pause-menu-control-row" data-pause-binding="${row.id}">
        <dt>${escapeHtml(row.label)}${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ''}</dt>
        <dd>${row.keys.map((key) => `<kbd>${escapeHtml(key)}</kbd>`).join('')}</dd>
      </div>`).join('')}</dl>
    </section>`).join('')}
  </section>`;
}

/** Native, presentation-only pause UI. GameApp owns the paused simulation. */
export class PauseMenu {
  readonly root: HTMLDialogElement;

  private readonly options: PauseMenuOptions;
  private readonly homePanel: HTMLElement;
  private readonly controlsPanel: HTMLElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly controlsButton: HTMLButtonElement;
  private readonly systemName: HTMLElement;
  private readonly location: HTMLElement;
  private readonly mode: HTMLElement;
  private readonly escapeLabel: HTMLElement;
  private readonly controlsScroll: HTMLElement;
  private view: PauseMenuView = 'home';
  private controlsMode: PauseControlsMode = 'flight';
  private previouslyFocused: HTMLElement | undefined;
  private notifiedOpen = false;
  private disposed = false;

  constructor(parent: HTMLElement, options: PauseMenuOptions) {
    this.options = options;
    this.root = document.createElement('dialog');
    this.root.className = 'pause-menu';
    this.root.dataset.pauseMenu = '';
    this.root.dataset.view = 'home';
    this.root.setAttribute('aria-labelledby', 'pause-menu-title');
    this.root.setAttribute('aria-describedby', 'pause-menu-description');
    this.root.innerHTML = `
      <div class="pause-menu-frame">
        <div class="pause-menu-topline"><span>VOID EXPLORER</span><span class="pause-menu-state"><i aria-hidden="true"></i>PAUSED</span></div>
        <section class="pause-menu-home" data-pause-panel="home">
          <header class="pause-menu-heading">
            <span class="pause-menu-kicker">EXPEDITION CONTROL</span>
            <h2 id="pause-menu-title">Expedition paused</h2>
            <p id="pause-menu-description">Your journey will continue from here.</p>
          </header>
          <div class="pause-menu-location">
            <span class="pause-menu-location-label">CURRENT LOCATION</span>
            <strong data-pause="system"></strong>
            <span class="pause-menu-location-detail" data-pause="location" hidden></span>
            <span class="pause-menu-mode" data-pause="mode" hidden></span>
          </div>
          <nav class="pause-menu-actions" aria-label="Pause menu">
            <button class="pause-menu-action pause-menu-action-primary" type="button" data-pause-action="resume" aria-label="Resume">
              <span><strong>Resume</strong><small>Return to your expedition</small></span><span class="pause-menu-action-mark" aria-hidden="true">→</span>
            </button>
            <button class="pause-menu-action" type="button" data-pause-action="settings" aria-label="Settings">
              <span><strong>Settings</strong><small>Graphics, appearance, and sound</small></span><span class="pause-menu-action-mark" aria-hidden="true">↗</span>
            </button>
            <button class="pause-menu-action" type="button" data-pause-action="controls" aria-label="Controls">
              <span><strong>Controls</strong><small>Flight and on-foot reference</small></span><span class="pause-menu-action-mark" aria-hidden="true">→</span>
            </button>
          </nav>
        </section>
        <section class="pause-menu-controls" data-pause-panel="controls" hidden>
          <header class="pause-menu-controls-heading">
            <button class="pause-menu-back" type="button" data-pause-action="back" aria-label="Back to pause menu"><span aria-hidden="true">←</span> Back</button>
            <h2 id="pause-menu-controls-title">Controls</h2>
            <p id="pause-menu-controls-description">Keyboard and mouse reference</p>
          </header>
          <div class="pause-menu-control-tabs" role="tablist" aria-label="Control mode">
            ${PAUSE_CONTROLS.map((section) => `<button type="button" role="tab" id="pause-controls-tab-${section.id}"
              data-pause-controls="${section.id}" aria-controls="pause-controls-panel-${section.id}"
              aria-selected="${section.id === 'flight'}" tabindex="${section.id === 'flight' ? 0 : -1}">${section.label}</button>`).join('')}
          </div>
          <div class="pause-menu-controls-scroll">${PAUSE_CONTROLS.map(controlsMarkup).join('')}</div>
        </section>
        <footer class="pause-menu-footer"><span>AURORA / FLIGHT SYSTEMS</span><span class="pause-menu-escape"><kbd>ESC</kbd><span data-pause="escape">RESUME</span></span></footer>
      </div>`;
    this.homePanel = this.root.querySelector('[data-pause-panel="home"]')!;
    this.controlsPanel = this.root.querySelector('[data-pause-panel="controls"]')!;
    this.resumeButton = this.root.querySelector('[data-pause-action="resume"]')!;
    this.controlsButton = this.root.querySelector('[data-pause-action="controls"]')!;
    this.systemName = this.root.querySelector('[data-pause="system"]')!;
    this.location = this.root.querySelector('[data-pause="location"]')!;
    this.mode = this.root.querySelector('[data-pause="mode"]')!;
    this.escapeLabel = this.root.querySelector('[data-pause="escape"]')!;
    this.controlsScroll = this.root.querySelector('.pause-menu-controls-scroll')!;
    this.root.addEventListener('keydown', this.onKeyDown);
    this.root.addEventListener('cancel', this.onCancel);
    this.root.addEventListener('close', this.onNativeClose);
    this.root.addEventListener('click', this.onClick);
    parent.append(this.root);
  }

  get isOpen(): boolean { return this.root.open; }

  open(context: PauseMenuContext): void {
    if (this.disposed) return;
    this.systemName.textContent = context.systemName;
    this.location.textContent = context.location ?? '';
    this.location.hidden = !context.location;
    this.mode.textContent = context.mode?.replaceAll('-', ' ').toUpperCase() ?? '';
    this.mode.hidden = !context.mode;
    // An existing pause dialog can remain underneath Settings. Updating its
    // context must not steal the top dialog's focus or reset its return point.
    if (this.root.open) return;
    this.previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.setView('home');
    if (typeof this.root.showModal === 'function') this.root.showModal();
    else this.root.setAttribute('open', '');
    this.notifiedOpen = true;
    this.options.onOpenChange?.(true);
    this.focus(this.resumeButton);
  }

  close(): void {
    if (this.root.open) {
      if (typeof this.root.close === 'function') this.root.close();
      else this.root.removeAttribute('open');
    }
    this.finishClose();
  }

  showHome(): void {
    if (this.disposed) return;
    const fromControls = this.view === 'controls';
    this.setView('home');
    this.focus(fromControls ? this.controlsButton : this.resumeButton);
  }

  showControls(): void {
    if (this.disposed) return;
    this.setView('controls');
    this.selectControlsMode(this.controlsMode, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.removeEventListener('cancel', this.onCancel);
    this.root.removeEventListener('close', this.onNativeClose);
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
  }

  private setView(view: PauseMenuView): void {
    this.view = view;
    this.root.dataset.view = view;
    this.homePanel.hidden = view !== 'home';
    this.controlsPanel.hidden = view !== 'controls';
    this.root.setAttribute('aria-labelledby', view === 'home' ? 'pause-menu-title' : 'pause-menu-controls-title');
    this.root.setAttribute('aria-describedby', view === 'home' ? 'pause-menu-description' : 'pause-menu-controls-description');
    this.escapeLabel.textContent = view === 'home' ? 'RESUME' : 'BACK';
  }

  private selectControlsMode(mode: PauseControlsMode, focus: boolean): void {
    this.controlsMode = mode;
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('[data-pause-controls]')) {
      const selected = tab.dataset.pauseControls === mode;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) this.focus(tab);
    }
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-pause-control-panel]')) {
      panel.hidden = panel.dataset.pauseControlPanel !== mode;
    }
    this.controlsScroll.scrollTop = 0;
  }

  private hasOtherOpenDialog(): boolean {
    return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')]
      .some((dialog) => dialog !== this.root);
  }

  private focus(element: HTMLElement): void {
    if (this.root.open && !this.hasOtherOpenDialog()) element.focus({ preventScroll: true });
  }

  private finishClose(): void {
    if (!this.notifiedOpen || this.root.open) return;
    this.notifiedOpen = false;
    const previous = this.previouslyFocused;
    this.previouslyFocused = undefined;
    if (!this.hasOtherOpenDialog() && previous?.isConnected && !previous.closest('[hidden], [inert]')) {
      previous.focus({ preventScroll: true });
    }
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    this.options.onOpenChange?.(false);
  }

  private requestEscape(event: Event): void {
    if (!this.root.open || this.disposed) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.view === 'controls') this.showHome();
    else this.options.onResume(event);
  }

  private readonly onNativeClose = (): void => { this.finishClose(); };
  private readonly onCancel = (event: Event): void => { this.requestEscape(event); };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.root.open || this.disposed) return;
    if (event.key === 'Escape') {
      if (event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      this.requestEscape(event);
      return;
    }
    // G/U still reach the application's pause input owner. Native Enter,
    // Space, Tab and scrolling also retain their normal accessible behavior.
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pause-controls]') : null;
    if (this.view !== 'controls' || !target) return;
    let mode: PauseControlsMode | undefined;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') mode = this.controlsMode === 'flight' ? 'onFoot' : 'flight';
    else if (event.key === 'Home') mode = 'flight';
    else if (event.key === 'End') mode = 'onFoot';
    if (!mode) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectControlsMode(mode, true);
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.root.open || this.disposed || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLButtonElement>('[data-pause-action], [data-pause-controls]');
    if (!target || !this.root.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    const mode = target.dataset.pauseControls;
    if (mode === 'flight' || mode === 'onFoot') {
      this.selectControlsMode(mode, true);
      return;
    }
    switch (target.dataset.pauseAction) {
      case 'resume': this.options.onResume(event); break;
      case 'settings': this.options.onSettings(); break;
      case 'controls': this.showControls(); break;
      case 'back': this.showHome(); break;
    }
  };
}
