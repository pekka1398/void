import { CELL_SIZE_METERS } from "../units";
import { lengthVec3, vec3, type Vec3 } from "../Vec3";

export type GalacticCell = [bigint, bigint, bigint];

export interface GalacticAddress {
  cell: GalacticCell;
  localMeters: Vec3;
}

export interface SerializedGalacticAddress {
  cell: [string, string, string];
  localMeters: Vec3;
}

function normalizeComponent(cell: bigint, localMeters: number): [bigint, number] {
  if (!Number.isFinite(localMeters)) throw new RangeError("Galactic coordinates must be finite");
  const displacement = Math.floor(localMeters / CELL_SIZE_METERS);
  let normalizedCell = cell + BigInt(displacement);
  let normalizedLocal = localMeters - displacement * CELL_SIZE_METERS;
  if (normalizedLocal >= CELL_SIZE_METERS) {
    normalizedCell += 1n;
    normalizedLocal -= CELL_SIZE_METERS;
  }
  if (normalizedLocal < 0) {
    normalizedCell -= 1n;
    normalizedLocal += CELL_SIZE_METERS;
  }
  return [normalizedCell, normalizedLocal];
}

export function normalizeAddress(address: GalacticAddress): GalacticAddress {
  const [xCell, x] = normalizeComponent(address.cell[0], address.localMeters.x);
  const [yCell, y] = normalizeComponent(address.cell[1], address.localMeters.y);
  const [zCell, z] = normalizeComponent(address.cell[2], address.localMeters.z);
  return { cell: [xCell, yCell, zCell], localMeters: vec3(x, y, z) };
}

export function addressFromMeters(positionMeters: Vec3): GalacticAddress {
  return normalizeAddress({ cell: [0n, 0n, 0n], localMeters: positionMeters });
}

export const createGalacticAddress = addressFromMeters;

export function addAddressOffset(address: GalacticAddress, offsetMeters: Vec3): GalacticAddress {
  return normalizeAddress({
    cell: [...address.cell],
    localMeters: vec3(
      address.localMeters.x + offsetMeters.x,
      address.localMeters.y + offsetMeters.y,
      address.localMeters.z + offsetMeters.z,
    ),
  });
}

export const addMetersToAddress = addAddressOffset;

export function subtractAddresses(address: GalacticAddress, origin: GalacticAddress): Vec3 {
  return vec3(
    Number(address.cell[0] - origin.cell[0]) * CELL_SIZE_METERS + (address.localMeters.x - origin.localMeters.x),
    Number(address.cell[1] - origin.cell[1]) * CELL_SIZE_METERS + (address.localMeters.y - origin.localMeters.y),
    Number(address.cell[2] - origin.cell[2]) * CELL_SIZE_METERS + (address.localMeters.z - origin.localMeters.z),
  );
}

export const renderRelativePosition = subtractAddresses;

export function distanceBetweenAddresses(left: GalacticAddress, right: GalacticAddress): number {
  return lengthVec3(subtractAddresses(left, right));
}

export function addressesEqual(left: GalacticAddress, right: GalacticAddress, epsilonMeters = 1e-6): boolean {
  return distanceBetweenAddresses(left, right) <= epsilonMeters;
}

export function serializeAddress(address: GalacticAddress): SerializedGalacticAddress {
  return {
    cell: [address.cell[0].toString(), address.cell[1].toString(), address.cell[2].toString()],
    localMeters: { ...address.localMeters },
  };
}

export function deserializeAddress(address: SerializedGalacticAddress): GalacticAddress {
  return normalizeAddress({
    cell: [BigInt(address.cell[0]), BigInt(address.cell[1]), BigInt(address.cell[2])],
    localMeters: { ...address.localMeters },
  });
}

export function cloneAddress(address: GalacticAddress): GalacticAddress {
  return { cell: [...address.cell], localMeters: { ...address.localMeters } };
}

export function addressToApproximateMeters(address: GalacticAddress): Vec3 {
  return vec3(
    Number(address.cell[0]) * CELL_SIZE_METERS + address.localMeters.x,
    Number(address.cell[1]) * CELL_SIZE_METERS + address.localMeters.y,
    Number(address.cell[2]) * CELL_SIZE_METERS + address.localMeters.z,
  );
}
