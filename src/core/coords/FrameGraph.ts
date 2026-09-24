import { addAddressOffset, subtractAddresses, type GalacticAddress } from "./GalacticAddress";
import { addVec3, vec3, type Vec3 } from "../Vec3";

export interface BodyFrame {
  id: string;
  origin: GalacticAddress;
  rotationRadians: number;
}

export function rotateAroundYAxis(position: Vec3, radians: number): Vec3 {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return vec3(position.x * cosine + position.z * sine, position.y, -position.x * sine + position.z * cosine);
}

export function bodyFixedToWorld(frame: BodyFrame, bodyFixedMeters: Vec3): GalacticAddress {
  return addAddressOffset(frame.origin, rotateAroundYAxis(bodyFixedMeters, frame.rotationRadians));
}

export function worldToBodyFixed(frame: BodyFrame, address: GalacticAddress): Vec3 {
  return rotateAroundYAxis(subtractAddresses(address, frame.origin), -frame.rotationRadians);
}

export function composeLocalOffsets(parentOffsetMeters: Vec3, childOffsetMeters: Vec3): Vec3 {
  return addVec3(parentOffsetMeters, childOffsetMeters);
}
