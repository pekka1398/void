import { DEFAULT_FLIGHT_KEY_BINDINGS } from '../simulation/ship/FlightController';
import type { FlightInputAction, FlightInputState } from '../simulation/ship/ShipState';
import type { OnFootInputAction } from '../simulation/player/OnFootController';

export type InputOwner = 'launch' | 'pause' | 'settings' | 'map' | 'flight' | 'cockpit' | 'parked' | 'transition' | 'onFoot';
export type InputCommand =
  | 'launch'
  | 'exit-board'
  | 'landing-takeoff'
  | 'pulse'
  | 'hyperdrive'
  | 'toggle-map'
  | 'toggle-view'
  | 'toggle-settings'
  | 'cycle-presentation'
  | 'reset'
  | 'celestial-slower'
  | 'celestial-faster'
  | 'escape';

export interface RoutedFlightInput {
  readonly input: Readonly<FlightInputState>;
  setInput(action: FlightInputAction, active: boolean): void;
}

export interface RoutedOnFootInput {
  setInput(action: OnFootInputAction, active: boolean): void;
  clearInput(): void;
  look(yawDeltaRadians: number, pitchDeltaRadians: number): void;
}

export interface InputRouterOptions {
  flight: RoutedFlightInput;
  onFoot: RoutedOnFootInput;
  owner?: InputOwner;
  onCommand?: (command: InputCommand, event: KeyboardEvent) => void;
  /** Clear the existing flight drag origin, mouse capture and presentation bank. */
  clearFlightPointer?: () => void;
  getPointerLockElement?: () => HTMLElement | undefined;
  document?: Document;
  onOwnerChanged?: (owner: InputOwner, previous: InputOwner) => void;
  onPointerLockChanged?: (locked: boolean) => void;
  lookRadiansPerPixel?: number;
}

export interface InputRouterSnapshot {
  owner: InputOwner;
  heldKeys: readonly string[];
  pointerLocked: boolean;
  pointerLockPending: boolean;
  pointerLockSupported: boolean;
  pointerLockDenied: boolean;
  draggingLook: boolean;
  lookMode: 'inactive' | 'idle' | 'pending' | 'locked' | 'drag';
}

export type OnFootPointerDown = Pick<PointerEvent, 'isTrusted' | 'button' | 'pointerId' | 'clientX' | 'clientY'>;
export type RoutedPointerMove = Pick<PointerEvent, 'movementX' | 'movementY'> &
  Partial<Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY' | 'buttons'>>;

interface DragLook {
  pointerId: number;
  clientX: number;
  clientY: number;
  element?: HTMLElement;
}

interface PendingPointerLock {
  serial: number;
  promise: Promise<boolean>;
  resolve: (locked: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const POINTER_LOCK_TIMEOUT_MILLISECONDS = 3_000;

export const DEFAULT_ON_FOOT_KEY_BINDINGS: Readonly<Record<string, OnFootInputAction>> = Object.freeze({
  KeyW: 'forward',
  KeyZ: 'forward',
  KeyS: 'backward',
  KeyA: 'left',
  KeyQ: 'left',
  KeyD: 'right',
  ArrowUp: 'forward',
  ArrowDown: 'backward',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
});

const COMMAND_KEYS: Readonly<Record<string, InputCommand>> = Object.freeze({
  Enter: 'launch',
  KeyX: 'exit-board',
  KeyL: 'landing-takeoff',
  KeyP: 'pulse',
  KeyH: 'hyperdrive',
  KeyM: 'toggle-map',
  Tab: 'toggle-map',
  KeyV: 'toggle-view',
  KeyG: 'toggle-settings',
  KeyN: 'cycle-presentation',
  KeyR: 'reset',
  BracketLeft: 'celestial-slower',
  BracketRight: 'celestial-faster',
  Escape: 'escape',
});

/**
 * Exactly one owner receives held movement keys. Either attach this router to
 * events or forward existing GameApp events to its public handlers, not both.
 */
export class InputRouter {
  private currentOwner: InputOwner;
  private readonly heldKeys = new Set<string>();
  private readonly document?: Document;
  private target?: EventTarget;
  private pointerTarget?: HTMLElement;
  private pendingPointerLock?: PendingPointerLock;
  private dragLook?: DragLook;
  private lockDenied = false;
  private lockIntent = false;
  private lockRequestSerial = 0;
  private lastPointerLocked = false;
  private disposed = false;

  constructor(private readonly options: InputRouterOptions) {
    this.currentOwner = options.owner ?? 'launch';
    this.document = options.document ?? (typeof document === 'undefined' ? undefined : document);
  }

  get owner(): InputOwner { return this.currentOwner; }
  get pointerLocked(): boolean {
    const element = this.options.getPointerLockElement?.();
    return Boolean(element && this.document?.pointerLockElement === element);
  }
  get pointerLockSupported(): boolean {
    return Boolean(this.document && typeof this.options.getPointerLockElement?.()?.requestPointerLock === 'function');
  }
  get snapshot(): InputRouterSnapshot {
    const pointerLocked = this.pointerLocked;
    const draggingLook = Boolean(this.dragLook);
    const pointerLockPending = Boolean(this.pendingPointerLock);
    return {
      owner: this.currentOwner,
      heldKeys: [...this.heldKeys],
      pointerLocked,
      pointerLockPending,
      pointerLockSupported: this.pointerLockSupported,
      pointerLockDenied: this.lockDenied,
      draggingLook,
      lookMode: this.currentOwner !== 'onFoot' ? 'inactive'
        : pointerLocked && this.lockIntent ? 'locked'
          : draggingLook ? 'drag' : pointerLockPending ? 'pending' : 'idle',
    };
  }

  setOwner(owner: InputOwner): void {
    if (owner === this.currentOwner || this.disposed) return;
    const previous = this.currentOwner;
    this.clear();
    this.currentOwner = owner;
    this.options.onOwnerChanged?.(owner, previous);
  }

  acceptsCommand(command: InputCommand): boolean {
    if (this.disposed) return false;
    if (this.currentOwner === 'pause') {
      return command === 'escape' || command === 'toggle-settings';
    }
    if (command === 'escape') return true;
    if (command === 'launch') return this.currentOwner === 'launch';
    if (this.currentOwner === 'launch') return false;
    if (command === 'toggle-settings') return this.currentOwner !== 'transition';
    if (this.currentOwner === 'settings') return false;
    if (command === 'cycle-presentation') return true;
    if (command === 'toggle-map') return this.currentOwner !== 'transition';
    if (command === 'exit-board') return this.currentOwner === 'parked' || this.currentOwner === 'onFoot' || this.currentOwner === 'transition';
    if (command === 'toggle-view') return this.currentOwner === 'flight' || this.currentOwner === 'cockpit' || this.currentOwner === 'parked';
    if (command === 'landing-takeoff' || command === 'pulse' || command === 'hyperdrive') {
      // Outside commands still reach the shared facade, which displays the
      // explicit BOARD AURORA TO DEPART rejection instead of silently firing.
      return this.currentOwner !== 'map';
    }
    return this.currentOwner !== 'map' && this.currentOwner !== 'transition';
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.disposed || isEditableTarget(event.target, this.currentOwner)) return false;
    const movement = this.movementBinding(event.code);
    if (movement) {
      this.heldKeys.add(event.code);
      this.reconcileMovement();
      if (event.code.startsWith('Arrow') || event.code === 'Space' || event.code.startsWith('Page')) event.preventDefault();
      return true;
    }
    const command = COMMAND_KEYS[event.code];
    if (!command || !this.acceptsCommand(command)) return false;
    event.preventDefault();
    if (event.repeat || this.heldKeys.has(event.code)) return true;
    this.heldKeys.add(event.code);
    // Escape also ends an unlocked drag or a browser request still in flight.
    // The command facade remains responsible for map/ship cancellation.
    if (command === 'escape' && this.currentOwner === 'onFoot') this.clear();
    this.options.onCommand?.(command, event);
    return true;
  }

  handleKeyUp(event: KeyboardEvent): boolean {
    const held = this.heldKeys.delete(event.code);
    const movement = this.movementBinding(event.code);
    if (held || movement) this.reconcileMovement();
    return held || Boolean(movement);
  }

  /** Begin usable look immediately; native pointer lock can finish or fail later. */
  handleOnFootPointerDown(event: OnFootPointerDown): boolean {
    if (this.disposed || this.currentOwner !== 'onFoot' || !event.isTrusted || event.button !== 0 ||
        !Number.isFinite(event.pointerId) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
    if (this.pointerLocked) return true;
    if (this.dragLook && this.dragLook.pointerId !== event.pointerId) return true;
    this.stopDragLook();
    const element = this.options.getPointerLockElement?.();
    this.dragLook = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, element };
    try { element?.setPointerCapture?.(event.pointerId); } catch { /* Window move/up still provide bounded drag look. */ }
    void this.requestPointerLockFromGesture(event);
    return true;
  }

  /** Forward both pointerup and pointercancel here. */
  handleOnFootPointerUp(event: Pick<PointerEvent, 'pointerId'>): boolean {
    if (this.disposed || this.currentOwner !== 'onFoot') return false;
    if (this.dragLook?.pointerId === event.pointerId) this.stopDragLook();
    return true;
  }

  handlePointerMove(event: RoutedPointerMove): boolean {
    if (this.disposed || this.currentOwner !== 'onFoot') return false;
    if (this.pointerLocked) {
      if (this.lockIntent) this.applyLook(event.movementX, event.movementY);
      return true;
    }
    const drag = this.dragLook;
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return false;
    // Recover even when a browser loses the release event outside its viewport.
    if (event.buttons !== undefined && (event.buttons & 1) === 0) {
      this.stopDragLook();
      return true;
    }
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      const deltaX = event.clientX! - drag.clientX;
      const deltaY = event.clientY! - drag.clientY;
      drag.clientX = event.clientX!;
      drag.clientY = event.clientY!;
      this.applyLook(deltaX, deltaY);
    } else {
      this.applyLook(event.movementX, event.movementY);
    }
    return true;
  }

  private applyLook(deltaX: number, deltaY: number): void {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const sensitivity = this.options.lookRadiansPerPixel ?? 0.0022;
    this.options.onFoot.look(-deltaX * sensitivity, -deltaY * sensitivity);
  }

  /** This must only be called from the real click/pointer gesture supplied by the UI. */
  requestPointerLockFromGesture(event: Pick<Event, 'isTrusted'>): Promise<boolean> {
    const element = this.options.getPointerLockElement?.();
    if (this.disposed || this.currentOwner !== 'onFoot' || !event.isTrusted ||
        !element || !this.document || typeof element.requestPointerLock !== 'function') return Promise.resolve(false);
    if (this.pointerLocked) {
      this.lockIntent = true;
      this.handlePointerLockChange();
      return Promise.resolve(true);
    }
    if (this.pendingPointerLock) return this.pendingPointerLock.promise;
    const serial = ++this.lockRequestSerial;
    this.lockDenied = false;
    this.lockIntent = true;
    let resolve!: (locked: boolean) => void;
    const promise = new Promise<boolean>((complete) => { resolve = complete; });
    const timeout = setTimeout(() => {
      if (this.pendingPointerLock?.serial !== serial) return;
      if (this.pointerLocked) this.completeNativePointerLock(serial);
      else this.handlePointerLockError();
    }, POINTER_LOCK_TIMEOUT_MILLISECONDS);
    this.pendingPointerLock = { serial, promise, resolve, timeout };
    try {
      // Older implementations return void and report completion through the
      // document events. Newer implementations also return a Promise.
      const requested = element.requestPointerLock();
      if (requested && typeof requested.then === 'function') {
        void requested.then(() => this.completeNativePointerLock(serial), () => {
          if (this.pendingPointerLock?.serial === serial) this.handlePointerLockError();
        });
      }
      this.completeNativePointerLock(serial);
    } catch {
      if (this.pendingPointerLock?.serial === serial) this.handlePointerLockError();
    }
    return promise;
  }

  handlePointerLockChange(): void {
    if (this.pointerLocked && (this.disposed || this.currentOwner !== 'onFoot' || !this.lockIntent)) {
      this.releasePointerLock();
      return;
    }
    const locked = this.pointerLocked;
    if (locked) {
      this.lockDenied = false;
      this.finishPointerLockRequest(true);
      this.stopDragLook();
    }
    if (this.lastPointerLocked && !locked) {
      this.heldKeys.clear();
      this.options.onFoot.clearInput();
      this.lockIntent = false;
      this.stopDragLook();
    }
    if (locked !== this.lastPointerLocked) this.options.onPointerLockChanged?.(locked);
    this.lastPointerLocked = locked;
  }

  /** Browser denial is visible to the HUD but never disables walking or drag look. */
  handlePointerLockError(): void {
    if (this.pendingPointerLock) {
      this.lockDenied = true;
      this.lockIntent = false;
      this.finishPointerLockRequest(false);
    }
    this.handlePointerLockChange();
  }

  handleBlur(): void { this.clear(); }

  clear(): void {
    this.heldKeys.clear();
    for (const action of Object.keys(this.options.flight.input) as FlightInputAction[]) {
      if (this.options.flight.input[action]) this.options.flight.setInput(action, false);
    }
    this.options.onFoot.clearInput();
    this.options.clearFlightPointer?.();
    this.lockRequestSerial += 1;
    this.lockIntent = false;
    this.lockDenied = false;
    this.finishPointerLockRequest(false);
    this.stopDragLook();
    this.releasePointerLock();
  }

  private completeNativePointerLock(serial: number): void {
    if (serial !== this.lockRequestSerial || this.disposed || this.currentOwner !== 'onFoot' || !this.lockIntent) {
      // A stale success must not recapture the mouse after Escape or a modal.
      // A newer trusted request is allowed to keep the lock it now owns.
      if (!this.lockIntent || this.disposed || this.currentOwner !== 'onFoot') this.releasePointerLock();
      return;
    }
    if (this.pointerLocked) this.handlePointerLockChange();
  }

  private finishPointerLockRequest(locked: boolean): void {
    const pending = this.pendingPointerLock;
    if (!pending) return;
    this.pendingPointerLock = undefined;
    clearTimeout(pending.timeout);
    pending.resolve(locked);
  }

  private stopDragLook(): void {
    const drag = this.dragLook;
    this.dragLook = undefined;
    if (!drag) return;
    try {
      if (drag.element?.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId);
    } catch { /* Pointer cancellation or a removed canvas already released it. */ }
  }

  private releasePointerLock(): void {
    if (this.pointerLocked) {
      try { this.document?.exitPointerLock(); } catch { /* A lost document already released it. */ }
    }
  }

  private movementBinding(code: string): FlightInputAction | OnFootInputAction | undefined {
    if (this.currentOwner === 'flight' || this.currentOwner === 'cockpit') return DEFAULT_FLIGHT_KEY_BINDINGS[code];
    if (this.currentOwner === 'onFoot') return DEFAULT_ON_FOOT_KEY_BINDINGS[code];
    return undefined;
  }

  private reconcileMovement(): void {
    if (this.currentOwner === 'flight' || this.currentOwner === 'cockpit') {
      const actions = new Set<FlightInputAction>();
      for (const key of this.heldKeys) {
        const action = DEFAULT_FLIGHT_KEY_BINDINGS[key];
        if (action) actions.add(action);
      }
      for (const action of Object.keys(this.options.flight.input) as FlightInputAction[]) {
        const active = actions.has(action);
        if (this.options.flight.input[action] !== active) this.options.flight.setInput(action, active);
      }
      return;
    }
    if (this.currentOwner === 'onFoot') {
      const actions = new Set<OnFootInputAction>();
      for (const key of this.heldKeys) {
        const action = DEFAULT_ON_FOOT_KEY_BINDINGS[key];
        if (action) actions.add(action);
      }
      for (const action of ['forward', 'backward', 'left', 'right', 'sprint'] as const) {
        this.options.onFoot.setInput(action, actions.has(action));
      }
    }
  }

  attach(target?: EventTarget): void {
    const resolved = target ?? (typeof window === 'undefined' ? undefined : window);
    if (!resolved || this.disposed || this.target === resolved) return;
    this.detach();
    this.target = resolved;
    this.pointerTarget = this.options.getPointerLockElement?.();
    resolved.addEventListener('keydown', this.onKeyDown);
    resolved.addEventListener('keyup', this.onKeyUp);
    resolved.addEventListener('pointermove', this.onPointerMove);
    resolved.addEventListener('pointerup', this.onPointerUp);
    resolved.addEventListener('pointercancel', this.onPointerUp);
    resolved.addEventListener('blur', this.onBlur);
    this.pointerTarget?.addEventListener('pointerdown', this.onPointerDown);
    this.document?.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.document?.addEventListener('pointerlockerror', this.onPointerLockError);
  }

  detach(): void {
    this.target?.removeEventListener('keydown', this.onKeyDown);
    this.target?.removeEventListener('keyup', this.onKeyUp);
    this.target?.removeEventListener('pointermove', this.onPointerMove);
    this.target?.removeEventListener('pointerup', this.onPointerUp);
    this.target?.removeEventListener('pointercancel', this.onPointerUp);
    this.target?.removeEventListener('blur', this.onBlur);
    this.pointerTarget?.removeEventListener('pointerdown', this.onPointerDown);
    this.document?.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.document?.removeEventListener('pointerlockerror', this.onPointerLockError);
    this.target = undefined;
    this.pointerTarget = undefined;
    this.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
  }

  private readonly onKeyDown = (event: Event): void => { this.handleKeyDown(event as KeyboardEvent); };
  private readonly onKeyUp = (event: Event): void => { this.handleKeyUp(event as KeyboardEvent); };
  private readonly onPointerDown = (event: Event): void => { this.handleOnFootPointerDown(event as PointerEvent); };
  private readonly onPointerMove = (event: Event): void => { this.handlePointerMove(event as PointerEvent); };
  private readonly onPointerUp = (event: Event): void => { this.handleOnFootPointerUp(event as PointerEvent); };
  private readonly onBlur = (): void => { this.handleBlur(); };
  private readonly onPointerLockChange = (): void => { this.handlePointerLockChange(); };
  private readonly onPointerLockError = (): void => { this.handlePointerLockError(); };
}

function isEditableTarget(target: EventTarget | null, owner: InputOwner): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as Partial<HTMLElement>;
  if (element.isContentEditable) return true;
  const tag = element.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'BUTTON' && (owner === 'settings' || owner === 'map' || owner === 'launch');
}
