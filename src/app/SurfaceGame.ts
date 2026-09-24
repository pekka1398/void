import { lengthVec3, type BodyFrame } from '../core';
import type { AuroraSurfaceKitManifest } from '../render/ship/AuroraSurfaceKit';
import { ContactSurfaceStreamer, prepareCpuContactCollider, type ContactFlowRegionResolver,
  type ContactSurfaceStreamerOptions } from '../terrain/ContactSurfaceStreamer';
import { SurfaceContactAuthority } from '../terrain/SurfaceContactAuthority';
import type { TerrainJobScheduler } from '../terrain/TerrainJobScheduler';
import { SurfaceMotionSolver } from '../simulation/player/SurfaceMotionSolver';
import { SurfaceSession } from '../simulation/player/SurfaceSession';
import {
  SurfaceLifecycleController,
  type SurfaceCommandResult,
  type SurfaceTravelIntent,
} from '../simulation/ship/SurfaceLifecycleController';
import type { FlightController } from '../simulation/ship/FlightController';
import {
  savedShipFromFlightState,
  type SurfacePersistenceAdapter,
  type SurfacePersistenceCapture,
} from '../simulation/persistence/GamePersistence';
import type { SavedSurfaceCheckpoint, UniverseCatalog } from '../universe';
import type { FlightViewMode } from '../render/ship/CockpitCamera';

export interface SurfaceGameOptions {
  readonly flight: FlightController;
  readonly catalog: UniverseCatalog;
  readonly contact: SurfaceContactAuthority;
  readonly scheduler: TerrainJobScheduler;
  readonly metersPerRenderUnit: number;
  /** Present only after the real GLB loader authenticated the additive kit. */
  readonly kit?: AuroraSurfaceKitManifest;
  readonly getViewMode: () => FlightViewMode;
  readonly restoreViewMode: (view: FlightViewMode) => void;
  /** Wait for the same immutable river/lava region shown by the planet before committing contact. */
  readonly resolveContactFlowRegion?: ContactFlowRegionResolver;
  readonly onContactCommitted?: ContactSurfaceStreamerOptions['onCommitted'];
  readonly onRecovery?: (reason: string) => void;
  readonly now?: () => number;
  readonly contactRestoreTimeoutMilliseconds?: number;
  readonly outsideRestoreTimeoutMilliseconds?: number;
}

/** Coordinates ownership, not physics: each subsystem retains its own truth. */
export class SurfaceGame implements SurfacePersistenceAdapter {
  readonly motion = new SurfaceMotionSolver();
  readonly contacts: ContactSurfaceStreamer;
  readonly lifecycle: SurfaceLifecycleController;
  readonly session: SurfaceSession;
  readonly kit: AuroraSurfaceKitManifest | undefined;
  private restoreStarted = false;
  private outsideRestoreStarted = false;
  private restoreStartedAt = 0;
  private outsideRestoreStartedAt = 0;

  constructor(private readonly options: SurfaceGameOptions) {
    this.kit = options.kit;
    this.contacts = new ContactSurfaceStreamer(options.contact, {
      scheduler: options.scheduler,
      metersPerRenderUnit: options.metersPerRenderUnit,
      resolveFlowRegion: options.resolveContactFlowRegion,
      prepareGeneration: (generation) => {
        if (options.contact.getLease(generation.leaseId)?.kind === 'actor') {
          return this.motion.prepareGeneration(generation);
        }
        // The ship's exact pad/sweep queries already use these immutable CPU
        // triangles. Rapier is loaded only when an actual actor lease needs it.
        return prepareCpuContactCollider(generation);
      },
      onCommitted: options.onContactCommitted,
    });
    this.lifecycle = new SurfaceLifecycleController({
      flight: options.flight,
      catalog: options.catalog,
      contact: options.contact,
      kit: this.kit,
      canDepart: () => this.session?.canDepart() ?? true,
    });
    this.session = new SurfaceSession({
      contact: options.contact,
      motion: this.motion,
      getParkedAnchor: () => this.lifecycle.parkedAnchor,
      isParkedAndSettled: () => this.lifecycle.isParkedAndSettled(),
      getSystemId: () => options.flight.state.systemId,
      getSurfaceKit: () => this.kit,
      getViewMode: options.getViewMode,
      restoreViewMode: options.restoreViewMode,
      gravityMetersPerSecondSquared: (bodyId, center) => {
        const body = options.catalog.getPlanet(bodyId);
        if (!body) return 0;
        const radius = Math.max(1, lengthVec3(center));
        return body.surfaceGravity * (body.radiusMeters / radius) ** 2;
      },
    });
  }

  /** Async streaming may finish while launch/settings keeps both clocks frozen. */
  serviceReadiness(frameKey?: number): void {
    this.contacts.update(frameKey);
    this.lifecycle.refreshContactReadiness();
    this.session.serviceReadiness();
  }

  step(deltaSeconds: number, celestialEpoch: number): void {
    if (!this.lifecycle.update(deltaSeconds, celestialEpoch)) {
      this.options.flight.update(deltaSeconds, celestialEpoch);
    }
    this.session.update(deltaSeconds, celestialEpoch);
  }

  requestLanding(): SurfaceCommandResult { return this.lifecycle.requestLanding(); }
  requestTakeoff(): SurfaceCommandResult { return this.lifecycle.requestTakeoff(); }
  requestTravel(intent: SurfaceTravelIntent): SurfaceCommandResult { return this.lifecycle.requestTravel(intent); }
  requestExit(): SurfaceCommandResult { return this.session.requestExit(); }
  requestBoard(): SurfaceCommandResult { return this.session.requestBoard(); }
  interact(): SurfaceCommandResult { return this.session.interact(); }

  cancel(): SurfaceCommandResult {
    return this.session.phase === 'inside'
      ? this.lifecycle.cancelSurfaceTransition()
      : this.session.cancelTransition();
  }

  get rampProgress(): number {
    const state = this.session.snapshot;
    if (state.phase === 'outside') return 1;
    if (state.phase === 'egressing') return smoothstep(Math.min(1, state.phaseProgress * 2.4));
    if (state.phase === 'boarding') return 1 - smoothstep(Math.max(0, (state.phaseProgress - 0.48) / 0.52));
    return 0;
  }

  getObserverPose(frame: BodyFrame) { return this.session.getObserverPose(frame); }

  captureCheckpoint(): SurfacePersistenceCapture | undefined {
    if (this.restoreStarted) return undefined;
    const ship = this.lifecycle.getStableCheckpoint();
    if (ship.kind === 'airborne') {
      return { ship: savedShipFromFlightState(ship.flight), surface: { kind: 'airborne', occupancy: 'inside' } };
    }
    const occupancy = this.session.getStableCheckpoint();
    return {
      ship: savedShipFromFlightState(ship.flight),
      surface: occupancy.occupancy === 'outside' && occupancy.actor
        ? { kind: 'parked', occupancy: 'outside', anchor: ship.anchor, actor: occupancy.actor }
        : { kind: 'parked', occupancy: 'inside', anchor: ship.anchor },
    };
  }

  restoreCheckpoint(checkpoint: SavedSurfaceCheckpoint, epoch: number): boolean {
    if (!this.restoreStarted) {
      this.restoreStarted = true;
      this.restoreStartedAt = this.now();
      this.outsideRestoreStarted = false;
      this.session.resetInside();
      this.lifecycle.reconcileAfterRestore(epoch,
        checkpoint.kind === 'parked' ? checkpoint.anchor : undefined);
    }
    this.lifecycle.refreshContactReadiness();
    if (checkpoint.kind === 'airborne' || !this.kit) return this.finishRestore();
    if (!this.lifecycle.isParkedAndSettled()) {
      const current = this.lifecycle.snapshot;
      if (current.surfacePhase === 'parked' && current.contactReady) {
        const recovered = this.lifecycle.recoverParkedContact();
        if (recovered.accepted) {
          this.options.onRecovery?.(recovered.reason);
          // A changed or invalid saved footprint cannot restore an astronaut
          // into it. Resume safely inside while the ordinary flare re-seats.
          return this.finishRestore();
        }
      }
      if (current.contactReady && current.surfacePhase === 'landing-armed') {
        // A v1 anchor or an older surface-kit layout is only a candidate.
        // Resume a safe footprint inside, then seat its real pads through the
        // normal flare. Never leave an unsafe migrated site held indefinitely.
        if (current.contactSafe) {
          this.options.onRecovery?.('surface-restore-reseating');
          return this.finishRestore();
        }
        this.session.resetInside();
        const recovered = this.lifecycle.recoverToSafeAirborne('surface-restore-unsafe-footprint');
        if (recovered.accepted) {
          this.options.onRecovery?.(recovered.reason);
          return this.finishRestore();
        }
      }
      const bodyId = checkpoint.anchor?.bodyId ?? checkpoint.legacyAnchor?.bodyId;
      const parkedLease = this.options.contact.statuses.find((status) =>
        status.lease.kind === 'parked-ship' && status.lease.bodyId === bodyId);
      const failed = parkedLease && this.contacts.getPreparationFailure(parkedLease.lease.id);
      const expired = this.now() - this.restoreStartedAt >=
        (this.options.contactRestoreTimeoutMilliseconds ?? 30_000);
      if (failed || expired) {
        const reason = failed ? 'surface-restore-contact-failed' : 'surface-restore-timeout';
        this.session.resetInside();
        const recovered = this.lifecycle.recoverToSafeAirborne(reason);
        if (recovered.accepted) {
          this.options.onRecovery?.(reason);
          return this.finishRestore();
        }
      }
      // An invalid legacy contact can safely become airborne; it must never
      // manufacture three pad contacts or erase the rest of the journey.
      return this.lifecycle.phase === 'airborne' ? this.finishRestore() : false;
    }
    if (checkpoint.occupancy !== 'outside') return this.finishRestore();
    if (!this.outsideRestoreStarted) {
      this.outsideRestoreStarted = true;
      this.outsideRestoreStartedAt = this.now();
      if (!this.session.restoreOutside(checkpoint.actor)) return this.finishRestore();
    }
    this.session.serviceReadiness();
    const occupancy = this.session.snapshot;
    if (!occupancy.restoringOutside) return this.finishRestore();
    const lease = occupancy.actorLeaseId ? this.options.contact.getLease(occupancy.actorLeaseId) : null;
    const failed = lease ? this.contacts.getPreparationFailure(lease.id) : undefined;
    const expired = this.now() - this.outsideRestoreStartedAt >=
      (this.options.outsideRestoreTimeoutMilliseconds ?? 20_000);
    if (!lease || failed || expired) {
      this.session.resetInside();
      this.options.onRecovery?.(expired ? 'outside-restore-timeout' : 'outside-restore-contact-failed');
      return this.finishRestore();
    }
    return false;
  }

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }

  private finishRestore(): true {
    this.restoreStarted = false;
    this.outsideRestoreStarted = false;
    this.restoreStartedAt = 0;
    this.outsideRestoreStartedAt = 0;
    return true;
  }

  /** Reset/QA teleport is explicit; an ordinary render-origin rebase never calls this. */
  reconcileAfterDiscontinuity(epoch: number): void {
    this.restoreStarted = false;
    this.outsideRestoreStarted = false;
    this.session.resetInside();
    this.lifecycle.reconcileAfterRestore(epoch, this.options.flight.state.parkedAnchor);
  }

  dispose(): void {
    this.session.dispose();
    this.lifecycle.dispose();
    this.contacts.dispose();
    this.motion.dispose();
  }
}

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}
