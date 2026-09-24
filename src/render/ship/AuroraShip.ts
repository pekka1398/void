import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { AURORA_ACTIVE_ASSET } from './AuroraAsset';
import { normalizeAuroraMaterials } from './AuroraMaterials';
import type { ShipVisual } from './ProceduralShip';

export const AURORA_SHIP_ASSET_URL = AURORA_ACTIVE_ASSET.url;
export const AURORA_SHIP_SCALE = AURORA_ACTIVE_ASSET.modelScale;
export const AURORA_ENGINE_NOZZLE_RADIUS = AURORA_ACTIVE_ASSET.nozzleRadiusMeters;

export interface AuroraShipLoadOptions {
  url?: string;
  quality?: 'high' | 'fallback';
  loader?: Pick<GLTFLoader, 'loadAsync'>;
  maximumTextureAnisotropy?: number;
}

/**
 * Replace only the visible procedural hull after its genuine authored model
 * has loaded. The old hull remains fully playable if loading really fails.
 */
export async function loadAuroraShip(
  ship: ShipVisual,
  options: AuroraShipLoadOptions = {},
): Promise<boolean> {
  const assetUrl = options.url ?? AURORA_SHIP_ASSET_URL;
  const loader = options.loader ?? new GLTFLoader();

  try {
    const asset: GLTF = await loader.loadAsync(assetUrl);
    if (!(asset.scene instanceof THREE.Group)) {
      throw new Error('The Aurora spacecraft GLB does not contain a loadable scene.');
    }

    const materials = normalizeAuroraMaterials(asset.scene, options.quality ?? 'high', {
      preserveAuthoredAppearance: true,
      maximumTextureAnisotropy: options.maximumTextureAnisotropy,
    });
    const installed = ship.installAuthoredModel?.(asset.scene, {
      assetId: AURORA_ACTIVE_ASSET.id,
      assetName: AURORA_ACTIVE_ASSET.name,
      assetUrl,
      scale: AURORA_SHIP_SCALE,
      nozzleRadius: AURORA_ENGINE_NOZZLE_RADIUS,
      materialCount: materials.materialCount,
      opaqueMeshCount: materials.opaqueMeshCount,
      emissiveMeshCount: materials.emissiveMeshCount,
      materialRoles: materials.roles,
      nodeMaterials: materials.nodeMaterials,
      transmissionPasses: materials.transmissionPasses,
    }) ?? false;

    if (!installed) {
      throw new Error('The Aurora spacecraft is missing its genuine engine or navigation sockets.');
    }

    return true;
  } catch (error) {
    ship.group.userData.assetLoaded = false;
    ship.group.userData.assetError = error instanceof Error ? error.message : String(error);
    console.error('Aurora spacecraft loading failed; retaining the procedural fallback.', error);
    return false;
  }
}
