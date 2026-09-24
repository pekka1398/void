import {
  addAddressOffset,
  cloneAddress,
  lerpVec3,
  scaleVec3,
  subtractAddresses,
  type GalacticAddress,
  type Vec3,
} from '../core';
import { orthonormalObserverBasis } from './ObserverPose';

export interface BodyFixedRenderPose {
  readonly bodyId: string;
  readonly positionMeters: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
}

export interface CanonicalRenderPose {
  readonly address: GalacticAddress;
  readonly forward: Vec3;
  readonly up: Vec3;
  readonly velocityMetersPerSecond: Vec3;
  readonly rollRadians: number;
  /** A body/system identity change is a discontinuity, never a path to interpolate through. */
  readonly frameId?: string;
  /** Resolve this interpolated local pose through the body's sampled-epoch frame. */
  readonly bodyFixed?: BodyFixedRenderPose;
}

export interface SimulationRenderFrame {
  readonly systemId: string;
  readonly simulationTimeSeconds: number;
  readonly celestialTimeSeconds: number;
  readonly ship: CanonicalRenderPose;
  readonly actor?: CanonicalRenderPose;
}

export interface InterpolatedRenderSnapshot extends SimulationRenderFrame {
  readonly interpolation: number;
  readonly discontinuitySerial: number;
}

function clonePose(pose: CanonicalRenderPose): CanonicalRenderPose {
  return {
    ...pose,
    address: cloneAddress(pose.address),
    forward: { ...pose.forward },
    up: { ...pose.up },
    velocityMetersPerSecond: { ...pose.velocityMetersPerSecond },
    ...(pose.bodyFixed ? { bodyFixed: cloneBodyFixedPose(pose.bodyFixed) } : {}),
  };
}

function cloneBodyFixedPose(pose: BodyFixedRenderPose): BodyFixedRenderPose {
  return {
    bodyId: pose.bodyId,
    positionMeters: { ...pose.positionMeters },
    forward: { ...pose.forward },
    up: { ...pose.up },
  };
}

function cloneFrame(frame: SimulationRenderFrame): SimulationRenderFrame {
  return {
    ...frame,
    ship: clonePose(frame.ship),
    ...(frame.actor ? { actor: clonePose(frame.actor) } : {}),
  };
}

function interpolateAngle(previous: number, current: number, alpha: number): number {
  const difference = Math.atan2(Math.sin(current - previous), Math.cos(current - previous));
  return previous + difference * alpha;
}

export function interpolateCanonicalRenderPose(
  previous: CanonicalRenderPose,
  current: CanonicalRenderPose,
  alpha: number,
): CanonicalRenderPose {
  if (previous.frameId !== current.frameId) return clonePose(current);
  const basis = orthonormalObserverBasis(
    lerpVec3(previous.forward, current.forward, alpha),
    lerpVec3(previous.up, current.up, alpha),
  );
  let bodyFixed = current.bodyFixed ? cloneBodyFixedPose(current.bodyFixed) : undefined;
  if (previous.bodyFixed && current.bodyFixed && previous.bodyFixed.bodyId === current.bodyFixed.bodyId) {
    const localBasis = orthonormalObserverBasis(
      lerpVec3(previous.bodyFixed.forward, current.bodyFixed.forward, alpha),
      lerpVec3(previous.bodyFixed.up, current.bodyFixed.up, alpha),
    );
    bodyFixed = {
      bodyId: current.bodyFixed.bodyId,
      positionMeters: lerpVec3(previous.bodyFixed.positionMeters, current.bodyFixed.positionMeters, alpha),
      forward: localBasis.forward,
      up: localBasis.up,
    };
  }
  return {
    ...current,
    address: addAddressOffset(previous.address, scaleVec3(subtractAddresses(current.address, previous.address), alpha)),
    forward: basis.forward,
    up: basis.up,
    velocityMetersPerSecond: lerpVec3(previous.velocityMetersPerSecond, current.velocityMetersPerSecond, alpha),
    rollRadians: interpolateAngle(previous.rollRadians, current.rollRadians, alpha),
    ...(bodyFixed ? { bodyFixed } : {}),
  };
}

/**
 * A two-frame immutable presentation history. The sampled celestial epoch is
 * the epoch at which callers evaluate bodies, light, weather, and observers.
 * A floating render-origin rebase is deliberately absent from this contract.
 */
export class RenderSnapshotBuffer {
  private previous: SimulationRenderFrame | undefined;
  private current: SimulationRenderFrame | undefined;
  private serial = 0;

  get discontinuitySerial(): number { return this.serial; }

  reset(frame?: SimulationRenderFrame): void {
    this.serial += 1;
    this.current = frame ? cloneFrame(frame) : undefined;
    this.previous = this.current;
  }

  push(frame: SimulationRenderFrame): void {
    if (!this.current || this.current.systemId !== frame.systemId ||
      frame.simulationTimeSeconds < this.current.simulationTimeSeconds ||
      frame.celestialTimeSeconds < this.current.celestialTimeSeconds) {
      this.reset(frame);
      return;
    }
    this.previous = this.current;
    this.current = cloneFrame(frame);
  }

  sample(interpolation: number): InterpolatedRenderSnapshot | undefined {
    if (!this.current) return undefined;
    const previous = this.previous ?? this.current;
    const current = this.current;
    const alpha = Number.isFinite(interpolation) ? Math.max(0, Math.min(1, interpolation)) : 0;
    const actor = current.actor
      ? previous.actor
        ? interpolateCanonicalRenderPose(previous.actor, current.actor, alpha)
        : clonePose(current.actor)
      : undefined;
    return {
      systemId: current.systemId,
      simulationTimeSeconds: previous.simulationTimeSeconds +
        (current.simulationTimeSeconds - previous.simulationTimeSeconds) * alpha,
      celestialTimeSeconds: previous.celestialTimeSeconds +
        (current.celestialTimeSeconds - previous.celestialTimeSeconds) * alpha,
      ship: interpolateCanonicalRenderPose(previous.ship, current.ship, alpha),
      ...(actor ? { actor } : {}),
      interpolation: alpha,
      discontinuitySerial: this.serial,
    };
  }
}
