import './surface-overlay.css';

export interface SurfaceOverlaySnapshot {
  readonly surfacePhase: string;
  readonly occupancyPhase: string;
  readonly phaseProgress: number;
  readonly occupancyProgress: number;
  readonly transitionFadeOpacity?: number;
  readonly clearanceMeters: number;
  readonly gearProgress: number;
  readonly canInteract: boolean;
  readonly interactionReason?: string;
  readonly movementReason?: string;
  readonly distanceToShipMeters?: number;
  readonly pointerLocked?: boolean;
  readonly pointerLockSupported?: boolean;
  readonly pointerLockDenied?: boolean;
  readonly lookMode?: 'inactive' | 'idle' | 'pending' | 'locked' | 'drag';
  readonly visible: boolean;
}

export interface SurfaceOverlayActions {
  readonly onInteract: (event: MouseEvent) => void;
  readonly onLook: (event: MouseEvent) => void;
}

const PHASE_LABELS: Readonly<Record<string, string>> = {
  'landing-armed': 'ASSESSING LANDING SITE',
  flare: 'CONTROLLED DESCENT',
  'touchdown-settle': 'CONTACT · SETTLING GEAR',
  parked: 'AURORA SECURED',
  'takeoff-spool': 'LIFT SYSTEMS ONLINE',
  'takeoff-rise': 'VERTICAL LIFTOFF',
  'takeoff-climb': 'CLEARING THE SURFACE',
};

const MOVEMENT_LABELS: Readonly<Record<string, string>> = {
  'terrain-loading': 'PREPARING NEARBY GROUND · PLEASE WAIT',
  unready: 'PREPARING NEARBY GROUND · PLEASE WAIT',
  ocean: 'OPEN WATER · STAY ON DRY GROUND',
  river: 'RIVER · FIND A DRY CROSSING',
  lava: 'LAVA · KEEP A SAFE DISTANCE',
  solid: 'PATH OBSTRUCTED · WALK AROUND',
  terrain: 'GROUND BLOCKS THIS PATH',
  slope: 'SLOPE TOO STEEP',
  unlandable: 'UNSAFE SURFACE',
};

/** Read-only presentation of the real surface and occupancy state machines. */
export class SurfaceOverlay {
  readonly root: HTMLDivElement;
  private readonly status: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly interact: HTMLButtonElement;
  private readonly look: HTMLButtonElement;
  private readonly lookHelp: HTMLElement;
  private readonly movementStatus: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly fade: HTMLElement;
  private lastLabel = '';
  private hasUsedLook = false;

  constructor(parent: HTMLElement, actions: SurfaceOverlayActions) {
    this.root = document.createElement('div');
    this.root.className = 'surface-overlay';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="surface-transition-fade" aria-hidden="true"></div>
      <section class="surface-status" aria-label="Surface operations">
        <div class="surface-status-kicker"><span></span> SURFACE OPERATIONS</div>
        <strong data-surface="status" role="status" aria-live="polite"></strong>
        <div data-surface="detail"></div>
        <div class="surface-status-track" aria-hidden="true"><span data-surface="progress"></span></div>
        <div class="surface-status-actions">
          <button type="button" data-surface-action="look" hidden><span></span></button>
          <button type="button" data-surface-action="interact"><kbd>X</kbd><span></span></button>
        </div>
        <div class="surface-look-help" data-surface="look-help" hidden></div>
        <div class="surface-movement-status" data-surface="movement-status" role="status" aria-live="polite" hidden></div>
        <div class="surface-controls" data-surface="controls"></div>
      </section>`;
    parent.append(this.root);
    this.status = this.root.querySelector('[data-surface="status"]')!;
    this.detail = this.root.querySelector('[data-surface="detail"]')!;
    this.progress = this.root.querySelector('[data-surface="progress"]')!;
    this.interact = this.root.querySelector('[data-surface-action="interact"]')!;
    this.look = this.root.querySelector('[data-surface-action="look"]')!;
    this.lookHelp = this.root.querySelector('[data-surface="look-help"]')!;
    this.movementStatus = this.root.querySelector('[data-surface="movement-status"]')!;
    this.controls = this.root.querySelector('[data-surface="controls"]')!;
    this.fade = this.root.querySelector('.surface-transition-fade')!;
    this.interact.addEventListener('click', actions.onInteract);
    this.look.addEventListener('click', actions.onLook);
  }

  update(snapshot: SurfaceOverlaySnapshot): void {
    const outside = snapshot.occupancyPhase === 'outside';
    const transition = ['exit-prewarm', 'egressing', 'boarding'].includes(snapshot.occupancyPhase);
    const active = snapshot.surfacePhase !== 'airborne' || snapshot.occupancyPhase !== 'inside';
    this.root.hidden = !snapshot.visible || !active;
    this.root.dataset.surfacePhase = snapshot.surfacePhase;
    this.root.dataset.occupancy = snapshot.occupancyPhase;
    const lookMode = snapshot.lookMode ?? (snapshot.pointerLocked ? 'locked' : 'idle');
    this.root.dataset.lookMode = lookMode;
    if (!outside) this.hasUsedLook = false;
    else if (lookMode === 'locked' || lookMode === 'drag') this.hasUsedLook = true;
    if (this.root.hidden) return;

    const label = outside ? 'ON FOOT'
      : snapshot.occupancyPhase === 'exit-prewarm' ? 'PREPARING SAFE EGRESS'
        : snapshot.occupancyPhase === 'egressing' ? 'LEAVING AURORA'
          : snapshot.occupancyPhase === 'boarding' ? 'BOARDING AURORA'
            : PHASE_LABELS[snapshot.surfacePhase] ?? 'SURFACE OPERATIONS';
    if (label !== this.lastLabel) {
      this.status.textContent = label;
      this.lastLabel = label;
    }
    const clearance = Number.isFinite(snapshot.clearanceMeters)
      ? `${Math.max(0, snapshot.clearanceMeters).toFixed(1)} M CLEARANCE` : 'CONTACT SOLUTION PENDING';
    const distance = Number.isFinite(snapshot.distanceToShipMeters)
      ? `AURORA · ${Math.max(0, snapshot.distanceToShipMeters!).toFixed(0)} M` : 'AURORA PARKED';
    this.detail.textContent = outside ? distance
      : transition ? snapshot.interactionReason ?? 'BODY-FIXED SURFACE LINK'
        : snapshot.surfacePhase === 'parked' ? 'GEAR DOWN · DRIVE IDLE'
          : `${clearance} · GEAR ${Math.round(snapshot.gearProgress * 100)}%`;
    const fraction = Math.max(0, Math.min(1, transition ? snapshot.occupancyProgress : snapshot.phaseProgress));
    this.progress.style.transform = `scaleX(${outside || snapshot.surfacePhase === 'parked' ? 1 : fraction})`;
    this.interact.hidden = transition || (!outside && snapshot.surfacePhase !== 'parked');
    this.interact.disabled = !snapshot.canInteract;
    this.interact.querySelector('span')!.textContent = outside ? 'BOARD AURORA' : 'EXIT AURORA';
    this.interact.title = snapshot.interactionReason ?? (outside && !snapshot.canInteract ? 'Return to the boarding ramp' : '');
    const lookActive = lookMode === 'locked' || lookMode === 'drag';
    const lockSupported = snapshot.pointerLockSupported !== false;
    this.look.hidden = !outside || lookActive;
    this.look.disabled = lookMode === 'pending';
    this.look.querySelector('span')!.textContent = lookMode === 'pending' ? 'STARTING MOUSE LOOK…'
      : !lockSupported ? 'RESUME EXPLORING'
        : snapshot.pointerLockDenied ? 'RETRY MOUSE LOOK'
          : this.hasUsedLook ? 'RESUME MOUSE LOOK' : 'START MOUSE LOOK';
    this.lookHelp.hidden = !outside || lookActive;
    this.lookHelp.textContent = !lockSupported || snapshot.pointerLockDenied
      ? 'Mouse capture unavailable. Hold the left mouse button to look around.'
      : 'Click to look freely, or hold the left mouse button and drag.';
    const movementLabel = outside && snapshot.movementReason && snapshot.movementReason !== 'clear'
      ? MOVEMENT_LABELS[snapshot.movementReason] ?? snapshot.movementReason.replaceAll('-', ' ').toUpperCase()
      : '';
    this.movementStatus.hidden = !movementLabel;
    if (this.movementStatus.textContent !== movementLabel) this.movementStatus.textContent = movementLabel;
    this.controls.textContent = outside
      ? 'WASD MOVE · ESC MENU'
      : snapshot.surfacePhase === 'parked' && !transition ? 'L LIFTOFF · ESC MENU' : '';
    // Only the cabin handoff is masked. Approach, touchdown, walking and
    // liftoff always show the actual continuously rendered physical world.
    const fade = ['egressing', 'boarding'].includes(snapshot.occupancyPhase)
      ? Math.max(0, Math.min(1, snapshot.transitionFadeOpacity ?? 0)) : 0;
    this.fade.style.opacity = String(fade);
  }

  dispose(): void {
    this.root.remove();
  }
}
