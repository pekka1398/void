import manifest from './aurora-four-wing-v4.asset.json';
import type { Vec3 } from '../../core';

export type AuroraEngineSocketName =
  | 'SOCKET_ENGINE_PORT'
  | 'SOCKET_ENGINE_STARBOARD';

export type AuroraNavigationSocketName =
  | 'SOCKET_NAV_PORT'
  | 'SOCKET_NAV_STARBOARD'
  | 'SOCKET_NAV_FORE_PORT'
  | 'SOCKET_NAV_FORE_STARBOARD'
  | 'SOCKET_NAV_AFT_PORT'
  | 'SOCKET_NAV_AFT_STARBOARD';

export type AuroraAssetSocketName = AuroraEngineSocketName | AuroraNavigationSocketName;

export interface AuroraClosedShellTopology {
  readonly boundaryEdges: number;
  readonly nonManifoldEdges: number;
  readonly windingConflicts: number;
  readonly connectedShells: number;
  readonly signedVolumeMeters3: number;
}

export interface AuroraCanopyAttachment {
  readonly version: 1;
  readonly canopySourceName: string;
  readonly coamingSourceName: string;
  readonly perimeterProbeCount: number;
  readonly minimumOverlapMeters: number;
  readonly perimeterProbes: readonly {
    readonly pointBlender: readonly number[];
    readonly overlapMeters: number;
  }[];
  readonly sourceTopology: {
    readonly canopy: AuroraClosedShellTopology;
    readonly coaming: AuroraClosedShellTopology;
  };
}

export interface AuroraPanelFitEvidenceProbe {
  readonly pointBlender: readonly number[];
  readonly overlapMeters: number;
  readonly exteriorClearanceMeters: number;
}

export interface AuroraFittedSourcePart {
  readonly sourceName: string;
  readonly kind: string;
  readonly side: 'PORT' | 'STARBOARD' | 'CENTER';
  readonly receiverSourceNames: readonly string[];
  readonly underside: boolean;
  readonly testedSurfaceTriangleCount: number;
  readonly minimumOverlapMeters: number;
  readonly minimumExteriorClearanceMeters: number;
  readonly maximumExteriorClearanceMeters: number;
  readonly evidenceProbes: readonly AuroraPanelFitEvidenceProbe[];
}

export interface AuroraPanelFit {
  readonly version: 1;
  readonly algorithm: 'evaluated-solid-attachment-v1';
  readonly revisedPartCount: number;
  readonly closedPartCount: number;
  readonly conformalPanelCount: number;
  readonly finMountCount: number;
  readonly wingVeinCount: number;
  readonly testedSurfaceTriangleCount: number;
  readonly minimumOverlapMeters: number;
  readonly parts: readonly AuroraFittedSourcePart[];
  readonly finRootAttachment: {
    readonly probeCount: number;
    readonly minimumBodyOverlapMeters: number;
    readonly minimumFinOverlapMeters: number;
    readonly probes: readonly {
      readonly side: 'PORT' | 'STARBOARD';
      readonly pointBlender: readonly number[];
      readonly bodyOverlapMeters: number;
      readonly finOverlapMeters: number;
    }[];
  };
}

export interface AuroraAssetGeometryShape {
  readonly wingCount: number;
  readonly navigationFixtureCount: number;
  readonly engineCount: number;
  readonly dorsalFinCount: number;
  readonly integratedNacelleMounts: number;
  readonly opaqueForwardEngineBulkheads: number;
  readonly completeRadiatorCount: number;
  readonly engineNozzleRadiusMeters: number;
  readonly mirrorAxis: string;
  readonly symmetryMaxErrorMeters: number;
  readonly openGapProbeCount: number;
  readonly gapProbeCoordinatesBlender: readonly (readonly number[])[];
  readonly integratedForeWingRootFairings?: number;
  readonly wingRootAttachmentProbeCount?: number;
  readonly minimumWingRootOverlapMeters?: number;
  readonly wingRootAttachmentProbes?: readonly {
    readonly side: 'PORT' | 'STARBOARD';
    readonly position: 'FORE' | 'AFT';
    readonly pointBlender: readonly number[];
    readonly overlapMeters: number;
  }[];
  readonly wingSweepForwardMeters?: {
    readonly fore: number;
    readonly aft: number;
  };
  readonly canopyAttachment?: AuroraCanopyAttachment;
  readonly panelFit?: AuroraPanelFit;
  readonly independentWingPlanforms: {
    readonly fore: readonly (readonly number[])[];
    readonly aft: readonly (readonly number[])[];
  };
}

export interface AuroraCanopyPressureSealRevision {
  readonly version: 1;
  readonly kind: 'canopy-pressure-seal';
  readonly algorithm: 'aurora-indexed-position-normal-v1';
  readonly referenceGlbSha256: string;
  readonly referenceGeometrySha256: string;
  readonly changedRoles: readonly ('navy' | 'canopy')[];
  readonly protectedNavy: {
    readonly triangleCount: number;
    readonly sha256: string;
  };
  readonly exteriorCanopyRoof: {
    readonly triangleCount: number;
    readonly sha256: string;
  };
}

export interface AuroraHullPanelFitRevision {
  readonly version: 1;
  readonly kind: 'hull-panel-fit';
  readonly algorithm: 'aurora-indexed-position-normal-v1';
  readonly referenceGlbSha256: string;
  readonly referenceSourceSha256: string;
  readonly referenceGeometrySha256: string;
  readonly changedRoles: readonly AuroraAssetMaterialRole[];
  readonly changedSourceNames: readonly string[];
  readonly removedSourceNames: readonly string[];
  readonly addedSourceNames: readonly string[];
  readonly changedSourcePartsSha256: string;
  readonly protectedSourceNames: {
    readonly count: number;
    readonly sha256: string;
  };
  readonly protectedGeometry: {
    readonly sha256: string;
    readonly triangleCount: number;
    readonly roles: Readonly<Record<AuroraAssetMaterialRole, {
      readonly triangleCount: number;
      readonly sha256: string;
    }>>;
  };
  readonly preservedCanopy: {
    readonly canopy: {
      readonly triangleCount: number;
      readonly sha256: string;
    };
    readonly coaming: {
      readonly triangleCount: number;
      readonly sha256: string;
    };
    readonly exteriorRoof: {
      readonly triangleCount: number;
      readonly sha256: string;
    };
  };
}

export type AuroraAssetGeometryRevision =
  | AuroraCanopyPressureSealRevision
  | AuroraHullPanelFitRevision;

export interface AuroraAssetGeometry {
  readonly bounds: {
    readonly min: Readonly<Vec3>;
    readonly max: Readonly<Vec3>;
  };
  /** Source-authored, verified hull symmetry and real clear-wing-gap probes. */
  readonly shape: AuroraAssetGeometryShape;
  readonly revision?: AuroraAssetGeometryRevision;
}

export type AuroraAssetMaterialRole =
  | 'ivory'
  | 'indigo'
  | 'navy'
  | 'metal'
  | 'canopy'
  | 'cyan'
  | 'magenta'
  | 'amber';

export type AuroraTexturedMaterialRole = 'ivory' | 'indigo' | 'navy' | 'metal';

export interface AuroraSurfaceTexture {
  readonly name: string;
  readonly mimeType: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly sourceSha256: string;
}

export interface AuroraAssetSurfaceFinish {
  readonly version: 1;
  readonly texturedRoles: readonly AuroraTexturedMaterialRole[];
  readonly uv: {
    readonly sourceLayer: 'AURORA_Surface_UV';
    readonly attribute: 'TEXCOORD_0';
    readonly texCoord: 0;
    readonly algorithm: 'aurora-indexed-position-uv-v1';
    readonly sha256: string;
    readonly triangleCount: number;
  };
  readonly textures: {
    readonly baseColor: AuroraSurfaceTexture & {
      readonly colorSpace: 'srgb';
    };
    readonly metallicRoughness: AuroraSurfaceTexture & {
      readonly colorSpace: 'linear';
      readonly channels: {
        readonly roughness: 'G';
        readonly metalness: 'B';
      };
    };
  };
  readonly materialFactors: Readonly<Record<AuroraAssetMaterialRole, {
    readonly baseColorFactor: readonly [number, number, number, number];
    readonly roughnessFactor: number;
    readonly metallicFactor: number;
  }>>;
  readonly preservedGeometry: {
    readonly algorithm: 'aurora-indexed-position-normal-v1';
    readonly referenceGlbSha256: string;
    readonly sha256: string;
    readonly triangleCount: number;
    readonly roles: Readonly<Record<AuroraAssetMaterialRole, {
      readonly triangleCount: number;
      readonly sha256: string;
    }>>;
  };
}

export interface AuroraAssetManifest {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly modelScale: number;
  readonly nozzleRadiusMeters: number;
  readonly triangleCount: number;
  readonly materialCount: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly sourceSha256: string;
  readonly canopyNodeName: string;
  readonly canopyBounds: {
    readonly min: Readonly<Vec3>;
    readonly max: Readonly<Vec3>;
  };
  readonly sockets: Readonly<
    Record<AuroraEngineSocketName, Readonly<Vec3>> &
    Partial<Record<AuroraNavigationSocketName, Readonly<Vec3>>>
  >;
  readonly geometry?: AuroraAssetGeometry;
  readonly surfaceFinish?: AuroraAssetSurfaceFinish;
}

/** Authenticated measurements from the actual approved, exported gameplay GLB. */
export const AURORA_ACTIVE_ASSET: Readonly<AuroraAssetManifest> = Object.freeze(
  // JSON imports widen the exporter-validated four-channel color tuples.
  manifest as unknown as AuroraAssetManifest,
);

/** The approved GLB was authored and exported in real meters. */
export const AURORA_PHYSICAL_METERS_PER_GLTF_UNIT = 1;

/** Historical camera-local presentation only; never a physical collision scale. */
export const AURORA_FOREGROUND_PRESENTATION_SCALE = AURORA_ACTIVE_ASSET.modelScale;
