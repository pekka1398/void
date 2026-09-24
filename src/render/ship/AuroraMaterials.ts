import * as THREE from 'three';
import { materialColor, materialRoughness, positionLocal, sin } from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';

/** The same authored spacecraft is presented by both real renderer backends. */
export type AuroraMaterialQuality = 'high' | 'fallback';

export type AuroraMaterialRole =
  | 'ivory'
  | 'indigo'
  | 'navy'
  | 'metal'
  | 'canopy'
  | 'cyan'
  | 'magenta'
  | 'amber';

export interface AuroraMaterialNormalization {
  readonly materialCount: number;
  readonly opaqueMeshCount: number;
  readonly emissiveMeshCount: number;
  readonly roles: readonly AuroraMaterialRole[];
  readonly nodeMaterials: true;
  readonly transmissionPasses: 0;
}

export interface AuroraMaterialNormalizationOptions {
  /** Retain the loaded spacecraft's genuine PBR palette and panel vertex tints. */
  readonly preserveAuthoredAppearance?: boolean;
  /** Actual initialized renderer limit; absent preserves authored texture sampling. */
  readonly maximumTextureAnisotropy?: number;
}

interface AuroraMaterialAppearance {
  readonly name: string;
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly highEmission: number;
  readonly fallbackEmission: number;
}

interface AuroraAuthoredSurfaceFinish {
  readonly brightnessAmplitude: number;
  readonly roughnessAmplitude: number;
  readonly longitudinalFrequency: number;
  readonly crosswiseFrequency: number;
}

/**
 * Eight deliberately distinct, reusable colors from the approved Blender ship.
 *
 * The tinted canopy remains a genuine faceted PBR surface, but never requests
 * glTF transmission, an offscreen backbuffer, or a transparent double pass.
 */
const AURORA_APPEARANCE: Readonly<Record<AuroraMaterialRole, AuroraMaterialAppearance>> = {
  ivory: {
    name: 'AURORA / ceramic ivory primary armor',
    color: 0xf2eadc,
    roughness: 0.36,
    metalness: 0.025,
    highEmission: 0,
    fallbackEmission: 0,
  },
  indigo: {
    name: 'AURORA / deep indigo wing armor',
    color: 0x212758,
    roughness: 0.40,
    metalness: 0.16,
    highEmission: 0,
    fallbackEmission: 0,
  },
  navy: {
    name: 'AURORA / midnight navy structural shell',
    color: 0x12182c,
    roughness: 0.45,
    metalness: 0.23,
    highEmission: 0,
    fallbackEmission: 0,
  },
  metal: {
    name: 'AURORA / burnished titanium engine hardware',
    color: 0x576a80,
    roughness: 0.36,
    metalness: 0.67,
    highEmission: 0,
    fallbackEmission: 0,
  },
  canopy: {
    name: 'AURORA / faceted teal flight canopy',
    color: 0x18bbaa,
    roughness: 0.23,
    metalness: 0.08,
    highEmission: 0,
    fallbackEmission: 0,
  },
  cyan: {
    name: 'AURORA / bounded cyan ion emission',
    color: 0x00eaff,
    roughness: 0.24,
    metalness: 0,
    highEmission: 2.55,
    fallbackEmission: 1.95,
  },
  magenta: {
    name: 'AURORA / magenta wingtip navigation light',
    color: 0xff2fc9,
    roughness: 0.26,
    metalness: 0,
    highEmission: 1.78,
    fallbackEmission: 1.38,
  },
  amber: {
    name: 'AURORA / restrained amber instrument light',
    color: 0xffaf56,
    roughness: 0.30,
    metalness: 0,
    highEmission: 0.82,
    fallbackEmission: 0.62,
  },
};

const AURORA_ROLE_ORDER: readonly AuroraMaterialRole[] = [
  'ivory',
  'indigo',
  'navy',
  'metal',
  'canopy',
  'cyan',
  'magenta',
  'amber',
];

/** Meter-scale manufactured finishes, never subpixel hash/grain or new maps. */
const AURORA_AUTHORED_SURFACE_FINISH: Partial<
  Readonly<Record<AuroraMaterialRole, AuroraAuthoredSurfaceFinish>>
> = {
  ivory: {
    brightnessAmplitude: 0.017,
    roughnessAmplitude: 0.018,
    longitudinalFrequency: 0.66,
    crosswiseFrequency: 1.18,
  },
  indigo: {
    brightnessAmplitude: 0.014,
    roughnessAmplitude: 0.015,
    longitudinalFrequency: 0.78,
    crosswiseFrequency: 1.12,
  },
  navy: {
    brightnessAmplitude: 0.010,
    roughnessAmplitude: 0.012,
    longitudinalFrequency: 0.68,
    crosswiseFrequency: 1.04,
  },
  metal: {
    brightnessAmplitude: 0.021,
    roughnessAmplitude: 0.022,
    longitudinalFrequency: 1.38,
    crosswiseFrequency: 1.72,
  },
  canopy: {
    brightnessAmplitude: 0.008,
    roughnessAmplitude: 0.007,
    longitudinalFrequency: 0.54,
    crosswiseFrequency: 0.91,
  },
};

function classifyAuroraMaterial(material: THREE.Material): AuroraMaterialRole {
  const name = material.name.toLowerCase();

  if (/magenta|wingtip navigation/.test(name)) return 'magenta';
  if (/cyan|ion emission/.test(name)) return 'cyan';
  if (/amber|instrument light/.test(name)) return 'amber';
  if (/ivory|porcelain/.test(name)) return 'ivory';
  if (/indigo/.test(name)) return 'indigo';
  if (/canopy frame|graphite|navy|structural shell/.test(name)) return 'navy';
  if (/flight canopy|teal canopy|faceted teal/.test(name)) return 'canopy';
  if (/titanium|silver|hardware|metal/.test(name)) return 'metal';

  throw new Error(`Unrecognized authored AURORA spacecraft material: ${material.name}`);
}

function applyAuthoredSurfaceFinish(
  material: MeshStandardNodeMaterial,
  role: AuroraMaterialRole,
): void {
  const finish = AURORA_AUTHORED_SURFACE_FINISH[role];
  if (!finish) return;

  // The actual AURORA role meshes share the same baked body-local meter frame.
  // Two broad coherent waves complement the authored ceramic/titanium maps
  // without additional textures, alias-prone noise, emissions, or extra draws.
  const longitudinal = sin(
    positionLocal.z.mul(finish.longitudinalFrequency)
      .add(positionLocal.x.mul(0.21)),
  );
  const crosswise = sin(
    positionLocal.x.mul(finish.crosswiseFrequency)
      .add(positionLocal.y.mul(0.34)),
  );
  const bodyFinish = longitudinal.mul(0.68).add(crosswise.mul(0.32));

  // NodeMaterial applies the genuine imported COLOR_0 once after colorNode.
  // Original material.color/roughness/metalness remain exact authored values.
  material.colorNode = materialColor.mul(
    bodyFinish.mul(finish.brightnessAmplitude).add(1),
  );
  material.roughnessNode = materialRoughness
    .add(bodyFinish.mul(finish.roughnessAmplitude))
    .clamp(0.12, 0.82);
  material.userData.authoredSurfaceFinish = {
    coordinateSpace: 'body-local-meters',
    brightnessAmplitude: finish.brightnessAmplitude,
    roughnessAmplitude: finish.roughnessAmplitude,
    maximumSpatialFrequency: Math.max(
      finish.longitudinalFrequency,
      finish.crosswiseFrequency,
    ),
    textureMaps: new Set(
      [material.map, material.roughnessMap, material.metalnessMap, material.normalMap]
        .filter((texture): texture is THREE.Texture => texture !== null),
    ).size,
  };
}

function createAuroraMaterial(
  role: AuroraMaterialRole,
  quality: AuroraMaterialQuality,
  original: THREE.Material,
  preserveAuthoredAppearance: boolean,
  hasAuthoredVertexColors: boolean,
): MeshStandardNodeMaterial {
  const appearance = AURORA_APPEARANCE[role];
  const authored = preserveAuthoredAppearance && original instanceof THREE.MeshStandardMaterial
    ? original
    : undefined;
  const color = authored?.color.clone() ?? new THREE.Color(appearance.color);
  const emissiveIntensity = quality === 'fallback'
    ? appearance.fallbackEmission
    : appearance.highEmission;
  const material = new MeshStandardNodeMaterial({
    name: authored?.name ?? appearance.name,
    color,
    roughness: authored?.roughness ?? appearance.roughness,
    metalness: authored?.metalness ?? appearance.metalness,
    emissive: emissiveIntensity > 0 ? color : 0x000000,
    emissiveIntensity,
    map: authored?.map ?? null,
    roughnessMap: authored?.roughnessMap ?? null,
    metalnessMap: authored?.metalnessMap ?? null,
    normalMap: authored?.normalMap ?? null,
    normalScale: authored?.normalScale.clone() ?? new THREE.Vector2(1, 1),
    vertexColors: preserveAuthoredAppearance && hasAuthoredVertexColors,
    side: THREE.FrontSide,
    transparent: false,
    opacity: 1,
    depthTest: true,
    depthWrite: true,
    fog: false,
  });

  // Genuine electric emitters remain linear until the existing HDR composition
  // performs its one output transform; broad hull surfaces stay star-lit.
  material.toneMapped = role !== 'cyan' && role !== 'magenta';
  material.userData.auroraRole = role;
  material.userData.authoredAuroraMaterial = true;
  material.userData.actualStellarLighting = true;
  material.userData.transmissionPasses = 0;
  material.userData.authoredAppearancePreserved = Boolean(authored);

  if (authored) {
    applyAuthoredSurfaceFinish(material, role);
  }

  return material;
}

/**
 * Normalize the actual loaded Blender GLB to bounded, physically lit node PBR.
 *
 * Material instances are shared by their real authored semantic role, including
 * the original 12-material concept if a caller ever loads it directly. Meshes,
 * geometry, hierarchy, source transforms, and all four real sockets are intact.
 */
export function normalizeAuroraMaterials(
  root: THREE.Object3D,
  quality: AuroraMaterialQuality = 'high',
  options: AuroraMaterialNormalizationOptions = {},
): AuroraMaterialNormalization {
  const preserveAuthoredAppearance = options.preserveAuthoredAppearance === true;
  const materials = new Map<AuroraMaterialRole, MeshStandardNodeMaterial>();
  const authoredTextures = new Set<THREE.Texture>();
  let opaqueMeshCount = 0;
  let emissiveMeshCount = 0;

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    const originals = Array.isArray(object.material)
      ? object.material
      : [object.material];
    const normalized = originals.map((original) => {
      const role = classifyAuroraMaterial(original);
      let replacement = materials.get(role);
      if (!replacement) {
        replacement = createAuroraMaterial(
          role,
          quality,
          original,
          preserveAuthoredAppearance,
          object.geometry.hasAttribute('color'),
        );
        materials.set(role, replacement);
        for (const texture of [
          replacement.map,
          replacement.roughnessMap,
          replacement.metalnessMap,
          replacement.normalMap,
        ]) {
          if (texture) authoredTextures.add(texture);
        }
      } else if (preserveAuthoredAppearance && object.geometry.hasAttribute('color')) {
        replacement.vertexColors = true;
      }
      return replacement;
    });

    object.material = Array.isArray(object.material) ? normalized : normalized[0]!;
    object.userData.auroraMaterialRoles = normalized.map(
      (material) => material.userData.auroraRole as AuroraMaterialRole,
    );

    opaqueMeshCount += 1;
    if (normalized.some((material) => material.emissiveIntensity > 0)) {
      emissiveMeshCount += 1;
    }
  });

  const roles = AURORA_ROLE_ORDER.filter((role) => materials.has(role));
  const result: AuroraMaterialNormalization = {
    materialCount: materials.size,
    opaqueMeshCount,
    emissiveMeshCount,
    roles,
    nodeMaterials: true,
    transmissionPasses: 0,
  };

  root.userData.auroraMaterialRoles = roles;
  root.userData.auroraMaterialCount = result.materialCount;
  root.userData.auroraOpaqueMeshCount = opaqueMeshCount;
  root.userData.auroraEmissiveMeshCount = emissiveMeshCount;
  root.userData.auroraNodeMaterials = true;
  root.userData.auroraTransmissionPasses = 0;
  root.userData.auroraMaterialQuality = quality;
  root.userData.auroraAuthoredAppearancePreserved = preserveAuthoredAppearance;
  root.userData.auroraAuthoredSurfaceFinish = preserveAuthoredAppearance;
  root.userData.auroraAuthoredTextureCount = authoredTextures.size;

  if (preserveAuthoredAppearance && options.maximumTextureAnisotropy !== undefined) {
    const actualMaximum = options.maximumTextureAnisotropy;
    const anisotropy = Math.min(
      4,
      Math.max(1, Number.isFinite(actualMaximum) ? Math.floor(actualMaximum) : 1),
    );

    // These are the same two genuine shared GLB textures, still unused by the
    // GPU. Both real backends support their existing linear+mipmap sampler.
    for (const texture of authoredTextures) texture.anisotropy = anisotropy;
  }

  if (authoredTextures.size > 0) {
    root.userData.auroraAuthoredTextureAnisotropy = Math.max(
      ...Array.from(authoredTextures, (texture) => texture.anisotropy),
    );
  }

  return result;
}
