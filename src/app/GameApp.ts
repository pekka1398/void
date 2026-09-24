import * as THREE from 'three';
import { positionLocal, uniform } from 'three/tsl';
import {
  AU_METERS,
  addAddressOffset,
  bodyFixedToWorld,
  cloneAddress,
  distanceVec3,
  FixedStepClock,
  formatDistance,
  formatDuration,
  formatSpeed,
  LIGHT_YEAR_METERS,
  rotateAroundYAxis,
  serializeAddress,
  subtractAddresses,
  worldToBodyFixed,
  vec3,
  type GalacticAddress,
  type Vec3,
} from '../core';
import { createHeroScenarios } from '../content';
import { apparentRadiusPixels, projectNavigationTarget } from './WorldNavigation';
import { InputRouter, type InputCommand, type InputOwner } from './InputRouter';
import { SurfaceGame } from './SurfaceGame';
import { createPlanetField, samplePlanetClimate, type PlanetField } from '../fields';
import { createPlanetGeologyProfile } from '../fields/PlanetGeology';
import { createPlanetWeather, type PlanetWeatherField } from '../fields/PlanetWeather';
import { evaluateCelestialLighting, resolveWorldIndirectLighting, type CelestialLightFrame } from '../lighting';
import { createPlanetEffects, type PlanetEffects } from '../render/planet/PlanetEffects';
import { advanceOrbitalCloudSelection } from '../render/planet/OrbitalCloudSelection';
import {
  createPlanetWeatherNodes,
  samplePlanetCloudTransmission,
  type PlanetWeatherNodes,
} from '../render/planet/PlanetWeatherNodes';
import { GpuTerrainDetail } from '../render/planet/GpuTerrainDetail';
import { createPlanetLandMaterial } from '../render/planet/PlanetLandMaterial';
import { createPlanetOceanDepth, type PlanetOceanDepthNodes } from '../render/planet/PlanetOceanDepth';
import {
  initialPlanetProxyDetail,
  PlanetProxyLod,
} from '../render/planet/PlanetProxyLod';
import {
  createSurfacePatchCoverageSetMask,
  type SurfacePatchCoverage,
  type SurfacePatchCoverageSetMask,
} from '../render/planet/SurfacePatchCoverage';
import {
  createSurfacePatch,
  sampleSurfaceOceanWave,
  SURFACE_OCEAN_LEVEL_METERS,
  type SurfacePatch,
} from '../render/planet/SurfacePatch';
import {
  createSurfaceDetailLayout,
  snapSurfaceDetailDirection,
  surfaceDetailClearanceMeters,
  surfaceDetailPresentation,
  surfaceDetailPrewarmClearance,
  surfaceDetailRecenterDistance,
  type SurfaceDetailLayer,
} from '../render/planet/SurfaceDetailPolicy';
import { NeonPostProcess } from '../render/post/NeonPostProcess';
import {
  cycleNeonPhosphorMode,
  DEFAULT_NEON_PHOSPHOR_MODE,
  normalizeNeonPhosphorMode,
  type NeonPhosphorMode,
} from '../render/post/NeonPhosphor';
import { RendererHost } from '../render/RendererHost';
import { FrameTiming } from '../render/FrameTiming';
import {
  applyObserverPose,
  createRigidObserverPose,
  orthonormalObserverBasis,
  rollObserverBasis,
  WORLD_METERS_PER_RENDER_UNIT,
  WORLD_NEAR_RENDER_UNITS,
  type ActiveObserverPose,
} from '../render/ObserverPose';
import {
  RenderSnapshotBuffer,
  type CanonicalRenderPose,
  type InterpolatedRenderSnapshot,
  type SimulationRenderFrame,
} from '../render/RenderSnapshot';
import { FlightCameraRig, type CameraBoomSweep, type CameraDiscontinuityReason } from '../render/camera/FlightCameraRig';
import {
  GRAPHICS_QUALITY_STORAGE_KEY,
  graphicsQualityReloadUrl,
  normalizeGraphicsQuality,
  resolveGraphicsQualityPreference,
  type GraphicsQuality,
} from '../render/GraphicsQuality';
import { CatalogStars, createNebula, createStarMesh } from '../render/space/CatalogStars';
import { createPlanetVisibility, type PlanetVisibility } from '../render/space/PlanetVisibility';
import { SpeedField } from '../render/space/SpeedField';
import { applyStellarSpaceEnvironment } from '../render/space/StellarSpaceEnvironment';
import {
  deriveSystemNebulaVolume,
  type SystemNebulaVolume,
} from '../render/space/SystemNebulaVolume';
import {
  deriveSystemVisualTheme,
  type SystemVisualTheme,
} from '../render/space/SystemVisualTheme';
import {
  resolveCockpitCameraPresentation,
  type FlightViewMode,
} from '../render/ship/CockpitCamera';
import { loadAuroraShip } from '../render/ship/AuroraShip';
import { AURORA_ACTIVE_ASSET } from '../render/ship/AuroraAsset';
import { loadAuroraSurfaceKit, type AuroraSurfaceKitVisual } from '../render/ship/AuroraSurfaceKit';
import { createProceduralShip, type ShipVisual } from '../render/ship/ProceduralShip';
import { ShipOverlay } from '../render/ship/ShipOverlay';
import { WorldShipPresentation } from '../render/ship/WorldShipPresentation';
import { SurfaceContactFX } from '../render/ship/SurfaceContactFX';
import { PALETTE } from '../render/style/Palette';
import { FlightController, GamePersistence, pulseArrivalRadiusMeters } from '../simulation';
import {
  landingAdmissionClearanceMeters,
  type SurfaceCommandResult,
  type SurfaceTravelIntent,
} from '../simulation/ship/SurfaceLifecycleController';
import type { SurfacePhase } from '../simulation/ship/ShipState';
import type { OccupancyPhase } from '../simulation/player/SurfaceSession';
import { createPlanetMesh, TerrainCollision, TerrainStreamer } from '../terrain';
import { SurfaceContactAuthority } from '../terrain/SurfaceContactAuthority';
import type { ContactLease } from '../terrain/ContactGeometry';
import type { ContactFlowRegionReadiness } from '../terrain/ContactSurfaceStreamer';
import { TerrainJobScheduler } from '../terrain/TerrainJobScheduler';
import { screenSpaceLodNoise } from '../terrain/TerrainLodTransition';
import {
  atmosphereSurfaceDensity,
  DEFAULT_CELESTIAL_TIME_SCALE,
  DiscoveryStore,
  hasRenderableAtmosphere,
  orbitalPeriodSeconds,
  sampleAtmosphereDensity,
  UniverseCatalog,
  type BodyPose,
  type PlanetDescriptor,
  type SystemSnapshot,
  type StarSystem,
} from '../universe';
import { CockpitOverlay } from '../ui/CockpitOverlay';
import { buildCockpitRadar, type CockpitRadarSnapshot } from '../ui/CockpitRadar';
import { Hud, type HudSnapshot, type MapEntry, type StarMapLayout } from '../ui/Hud';
import { buildLaunchPresentation } from '../ui/LaunchPresentation';
import { LaunchScreen } from '../ui/LaunchScreen';
import { DisplaySettings, type DisplaySettingsValues } from '../ui/DisplaySettings';
import { SurfaceOverlay } from '../ui/SurfaceOverlay';
import { PauseMenu } from '../ui/PauseMenu';
import { measureOrbitalMotion } from '../ui/OrbitalTelemetry';

const METERS_PER_RENDER_UNIT = WORLD_METERS_PER_RENDER_UNIT;
const LIVE_MAP_REFRESH_INTERVAL_SECONDS = 1 / 8;
const NEON_PHOSPHOR_STORAGE_KEY = 'void-explorer:display:neon-phosphor:v1';

type RichMapEntry = MapEntry & {
  parentId?: string;
  orbitalRadiusAu?: number;
  orbitalPhase?: number;
  radiusMeters?: number;
  color?: string;
  ringed?: boolean;
  isMoon?: boolean;
  distanceMeters?: number;
  position?: { x: number; y: number; z?: number };
  starCount?: number;
  spectralClass?: string;
  orbitalPeriodSeconds?: number;
  eccentricity?: number;
  inclinationRadians?: number;
  longitudeAscendingNodeRadians?: number;
  argumentPeriapsisRadians?: number;
  orbitalSpeedMetersPerSecond?: number;
  rotationPeriodSeconds?: number;
  surfaceGravity?: number;
  massKg?: number;
  moonCount?: number;
  isLandable?: boolean;
};

interface SceneWorldTarget {
  id: string;
  name: string;
  kind: 'planet' | 'system';
  x: number;
  y: number;
  visible: boolean;
  distance: string;
  label?: string;
  selected?: boolean;
  color?: string;
  radius?: number;
  offscreen?: boolean;
  bearingRadians?: number;
  description?: string;
}

type InteractiveHud = Hud & {
  setMapLayout?: (layout: StarMapLayout) => void;
  setWorldTargets?: (targets: SceneWorldTarget[]) => void;
  setHoverTarget?: (target?: string | SceneWorldTarget) => void;
  setTargetLock?: (targetId: string | undefined) => void;
  isMapOpen?: () => boolean;
  onApproach?: (id: string, kind: 'planet' | 'system') => void;
  onInspect?: (id: string, kind: 'planet' | 'system') => void;
};

interface BodyVisual {
  body: PlanetDescriptor;
  field: PlanetField;
  weatherField: PlanetWeatherField;
  weatherNodes: PlanetWeatherNodes;
  oceanDepth: PlanetOceanDepthNodes;
  group: THREE.Group;
  proxy: THREE.Mesh;
  proxyLod: PlanetProxyLod;
  effects: PlanetEffects;
  visibility: PlanetVisibility;
  streamer?: TerrainStreamer;
  collision?: TerrainCollision;
  surfacePatch?: SurfacePatch;
  surfaceDetails?: SurfacePatch[];
  surfaceLayout?: readonly SurfaceDetailLayer[];
  surfaceGroundClearanceMeters?: number;
  continuityCutoutDirection: THREE.Vector3;
  continuityCutoutCosine: { value: number };
  surfaceCoverageMask: SurfacePatchCoverageSetMask;
  orbitalTerrainAlpha: { value: number };
}

interface ExposedGameState {
  systemCount: number;
  systemId: string;
  systemName: string;
  celestialTimeScale: number;
  celestialTimeSeconds: number;
  localEffectsSeconds: number;
  mode: string;
  landed: boolean;
  landedBodyId?: string;
  surfacePhase: SurfacePhase;
  occupancyPhase: OccupancyPhase;
  contactReady: boolean;
  contactGenerationId?: string;
  actorBodyId?: string;
  actorGrounded: boolean;
  actorEyeHeightMeters: number;
  surfaceKitLoaded: boolean;
  shipWorldSpace: boolean;
  sharedWorldDepth: boolean;
  renderEpochSeconds: number;
  renderLocalEffectsSeconds: number;
  observerOwner: ActiveObserverPose['owner'];
  targetId?: string;
  speedMetersPerSecond: number;
  altitudeMeters: number;
  fps: number;
  particles: number;
  renderer: string;
  rendererDeviceStatus: 'initializing' | 'ready' | 'lost' | 'error' | 'disposed';
  rendererDeviceLost: boolean;
  rendererDeviceLossReason?: string;
  logarithmicDepth: boolean;
  quality: 'high' | 'fallback';
  graphicsQuality: GraphicsQuality;
  effectiveGraphicsQuality: GraphicsQuality;
  renderResolutionCap: Readonly<{ width: number; height: number }>;
  terrainTiles: number;
  terrainQueued: number;
  terrainGenerating: number;
  terrainTriangles: number;
  terrainReady: boolean;
  terrainReadiness: number;
  terrainPrewarmed: boolean;
  terrainPrewarming: boolean;
  terrainPrewarmAltitudeMeters: number;
  terrainVisibleTiles: number;
  terrainFadingTiles: number;
  terrainPendingUploads: number;
  terrainParentRetained: number;
  terrainLodTransitions: number;
  terrainPredictedLeadMeters: number;
  terrainCoverageSamples: number;
  terrainCoveredSamples: number;
  terrainHorizonCoverage: number;
  terrainForwardCoverage: number;
  terrainPredictedCoverage: number;
  terrainCoverageReady: boolean;
  terrainHorizonTiles: number;
  terrainSixRootCoverageReady: boolean;
  terrainGlobalAlpha: number;
  terrainViewCulledTiles: number;
  terrainOcclusionCulledTiles: number;
  terrainTransitionAlpha: number;
  terrainProxyAlpha: number;
  terrainChildAlpha: number;
  terrainTransitionVeil: number;
  planetContinuityVisible: boolean;
  planetProxyVisible: boolean;
  planetProxyDetail: number;
  planetProxyPendingDetail: number | null;
  planetProxyTransitioning: boolean;
  planetSurfaceVisible: boolean;
  terrainBodyId?: string;
  terrainFieldVersion: number;
  geographyFeatureCount: number;
  geographyReliefMeters: number;
  geographyFeatureId?: string;
  terrainMaxDepth: number;
  terrainTileSegments: number;
  surfacePatchVisible: boolean;
  surfacePatchAngularError: number;
  surfaceDecorations: number;
  surfaceDecorationsVisible: boolean;
  surfaceVegetation: number;
  surfaceCrystals: number;
  surfaceRidges: number;
  surfaceBiomeId: string;
  activeSurfaceArchetype?: string;
  surfaceRiverSegments: number;
  surfaceLavaSegments: number;
  surfaceVolcanicVents: number;
  surfaceCraters: number;
  surfaceEcologyFlora: number;
  surfaceEcologyRocks: number;
  surfaceEcologyDrawCalls: number;
  atmosphereFactor: number;
  atmosphereDensity: number;
  atmosphericDensity: number;
  cloudDensity: number;
  cloudInside: boolean;
  insideCloud: boolean;
  cloudBaseMeters: number;
  cloudTopMeters: number;
  cloudClusterCount: number;
  weatherClusterCount: number;
  nearCloudClusterCount: number;
  farCloudClusterCount: number;
  cloudCrossings: number;
  weatherHumidity: number;
  weatherOpticalDepth: number;
  weatherSurfaceClearanceMeters: number;
  weatherRareFormations: number;
  weatherPhase: number;
  weatherRegime: 'clear' | 'broken' | 'overcast' | 'storm';
  stormIntensity: number;
  cloudTransmission: number;
  cloudShadowStrength: number;
  cloudShadowSourceIds: string[];
  weatherVisibilityMeters: number;
  precipitation: number;
  windSpeedMetersPerSecond: number;
  cloudBodyId?: string;
  cloudCellKey?: string;
  discovered: number;
  renderWidth: number;
  renderHeight: number;
  renderPixelRatio: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  gpuComputeSupported: boolean;
  gpuTerrainComputeActive: boolean;
  gpuTerrainComputeDispatches: number;
  gpuTerrainCachedTiles: number;
  gpuTerrainComputeVertices: number;
  gpuTerrainComputePending: number;
  postLocalizedBloom: boolean;
  postHighlightShoulder: boolean;
  postStellarHdrBloom: boolean;
  postStellarSpectralHighlights: boolean;
  celestialLightSourceIds: string[];
  celestialLightCount: number;
  dominantVisibleSourceId?: string;
  directIrradiance: number;
  daylight: number;
  twilight: number;
  night: number;
  horizonBlockedSourceIds: string[];
  eclipsedSourceIds: string[];
  lightingExposure: number;
  lightingExposureTarget: number;
  postAdaptiveExposure: boolean;
  postPhysicalCelestialOptics: boolean;
  particleBudget: number;
  usedHeapBytes?: number;
  targetDistanceMeters: number;
  targetEtaSeconds: number;
  targetAlignment: number;
  targetCaptureAltitudeMeters: number;
  flightPhase: string;
  autopilotPhase?: string;
  autopilotDepartureBodyId?: string;
  autopilotClearanceMeters?: number;
  throttle: number;
  pitchRadians: number;
  yawRadians: number;
  surfaceInfluence: number;
  cameraAngularDelta: number;
  cameraReferenceUp: { x: number; y: number; z: number };
  viewMode: FlightViewMode;
  cockpitVisible: boolean;
  cockpitEyeOffsetMeters: { x: number; y: number; z: number };
  cockpitRadarContacts: number;
  cockpitRadarContactIds: string[];
  cockpitRadarFrameUpdates: number;
  cockpitRadarLastFrame: number;
  cockpitRadarEpoch?: number;
  cockpitRadarTargetId?: string;
  visibleDistantBodies: number;
  targetApparentDiameterPixels: number;
  targetBeaconDiameterPixels: number;
  shipForegroundPass: boolean;
  shipAssetLoaded: boolean;
  shipAssetId: string;
  shipAssetUrl: string;
  shipTriangles: number;
  shipMaterialBatches: number;
  shipMaterialRoles: string[];
  shipNodeMaterials: boolean;
  shipTransmissionPasses: number;
  postProcessing: boolean;
  postProcessingPasses: number;
  sceneAntialiasingSamples: 0 | 2 | 4;
  sceneAntialiasing: 'msaa' | 'edge-filter';
  spatialAntialiasing: 'none' | 'smaa';
  spatialAntialiasingPasses: number;
  neonPhosphorMode: NeonPhosphorMode;
  neonPhosphorEnabled: boolean;
  launchReady: boolean;
  launchEntered: boolean;
  launchVisible: boolean;
  pauseMenuOpen: boolean;
  blueFireParticleCount: number;
  exhaustDrawCalls: number;
  cosmicBiomeId: string;
  cosmicBiomeName: string;
  cosmicBiomeFamily: string;
  cosmicBiomeSeed: number;
  cosmicBiomePrimaryColor: string;
  cosmicBiomeSecondaryColor: string;
  cosmicBiomeAccentColor: string;
  cosmicBiomeDensity: number;
  cosmicBiomeCoverage: number;
  cosmicBiomeDrawCalls: number;
  cosmicBiomeOuterRadiusAu: number;
  cosmicBiomeAnchorKind: string;
  cosmicBiomeAtmosphericTransmittance: number;
  mapOpen: boolean;
  hoveredTargetId?: string;
}

declare global {
  interface Window {
    __VOID_EXPLORER__?: {
      app: GameApp;
      getState: () => ExposedGameState;
      setDemoState: (state: string) => void;
      setCelestialTimeScale: (scale: number) => number;
      getCatalog: () => { count: number; fingerprint: string };
      engageApproach: (id?: string) => boolean;
      requestLanding: () => SurfaceCommandResult;
      requestTakeoff: () => SurfaceCommandResult;
      requestExit: () => SurfaceCommandResult;
      requestBoard: () => SurfaceCommandResult;
      getSurfaceState: () => ReturnType<GameApp['getSurfaceState']>;
      getPerformanceState: () => ReturnType<GameApp['getPerformanceState']>;
      resetPerformanceSamples: () => void;
      setViewMode: (mode: FlightViewMode) => FlightViewMode;
      setNeonPhosphorMode: (mode: NeonPhosphorMode) => NeonPhosphorMode;
    };
  }
}

export class GameApp {
  private readonly parent: HTMLElement;
  private readonly loading: HTMLDivElement;
  private readonly scene = new THREE.Scene();
  private readonly backgroundScene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(57, 1, WORLD_NEAR_RENDER_UNITS, 120_000_000);
  private readonly clock = new THREE.Clock();
  private readonly simulationClock = new FixedStepClock(1 / 60, 6);
  private readonly renderHistory = new RenderSnapshotBuffer();
  private readonly flightCamera = new FlightCameraRig();
  private readonly frameTiming = new FrameTiming();
  private previousFrameWasActive = false;
  private readonly planetWorkFrustum = new THREE.Frustum();
  private readonly planetWorkProjection = new THREE.Matrix4();
  private readonly planetWorkBounds = new THREE.Sphere();
  private readonly catalog = new UniverseCatalog();
  private readonly discoveries = new DiscoveryStore(this.catalog.seed);
  private launchScreen: LaunchScreen | undefined;
  private displaySettings: DisplaySettings | undefined;
  private pauseMenu: PauseMenu | undefined;
  private pointerUnlockPauseFrame: number | undefined;
  private readonly graphicsQuality: GraphicsQuality;
  private graphicsReloadPending = false;
  private gameplayEntered = false;
  private readonly bodies = new Map<string, BodyVisual>();
  private readonly stars = new Map<string, THREE.Group>();
  private readonly bodyCenterLightingCache = new Map<string, {
    frame: CelestialLightFrame;
    localTimeSeconds: number;
  }>();
  private host!: RendererHost;
  private gpuTerrain!: GpuTerrainDetail;
  private terrainJobs!: TerrainJobScheduler;
  private lastSurfacePatchCommitFrame = -1;
  private contactAuthority!: SurfaceContactAuthority;
  private hud!: InteractiveHud;
  private cockpitOverlay!: CockpitOverlay;
  private flight!: FlightController;
  private surface!: SurfaceGame;
  private inputRouter!: InputRouter;
  private persistence!: GamePersistence;
  private ship!: ShipVisual;
  private worldShip!: WorldShipPresentation;
  private surfaceKit: AuroraSurfaceKitVisual | null = null;
  private surfaceKitError: string | undefined;
  private surfaceFx!: SurfaceContactFX;
  private shipOverlay!: ShipOverlay;
  private surfaceOverlay: SurfaceOverlay | undefined;
  private post!: NeonPostProcess;
  private speedField!: SpeedField;
  private starfield!: CatalogStars;
  private nebula: THREE.Points | undefined;
  private nebulaAnchorMeters = vec3();
  private systemVisualTheme: SystemVisualTheme | undefined;
  private systemNebulaVolume: SystemNebulaVolume | undefined;
  private currentSystem: StarSystem = this.catalog.heroSystem;
  private viewMode: FlightViewMode = 'chase';
  private neonPhosphorMode: NeonPhosphorMode = DEFAULT_NEON_PHOSPHOR_MODE;
  private cockpitRadar: CockpitRadarSnapshot | undefined;
  private cockpitRadarFrameUpdates = 0;
  private cockpitRadarLastFrame = 0;
  private frame = 0;
  private fps = 60;
  private simulationSeconds = 0;
  private localEffectsSeconds = 0;
  private renderEpochSeconds = 0;
  private renderLocalEffectsSeconds = 0;
  private renderInterpolation = 1;
  private renderSnapshot: InterpolatedRenderSnapshot | undefined;
  private renderShipPose: CanonicalRenderPose | undefined;
  private activeObserver: ActiveObserverPose | undefined;
  private renderObserverPosition = vec3();
  private renderObserverVelocity = vec3();
  private celestialTimeScale = DEFAULT_CELESTIAL_TIME_SCALE;
  private lastMapRefreshLocalSeconds = Number.NEGATIVE_INFINITY;
  private mapNearbySystemId: string | undefined;
  private mapNearbySystems: Array<{ system: StarSystem; distanceMeters: number }> = [];
  private animationFrame = 0;
  private bank = 0;
  private mouseCaptured = false;
  private pointerOrigin: { x: number; y: number } | undefined;
  private hoveredTargetId: string | undefined;
  private lastAutopilotPhase: string | undefined;
  private lastHoverSample = 0;
  private readonly sceneTargets = new Map<string, SceneWorldTarget>();
  private cameraViewOffset = vec3();
  private readonly cameraReferenceUp = new THREE.Vector3(0, 1, 0);
  private readonly previousCameraQuaternion = new THREE.Quaternion();
  private cameraAngularDelta = 0;
  private altitudeMeters = 0;
  private currentAtmosphereFactor = 0;
  private currentTerrainTransition = 0;
  private celestialLightingFrame: CelestialLightFrame | undefined;
  private cloudCrossings = 0;
  private previousCloudBodyId: string | undefined;
  private additionalOrbitalCloudBodyId: string | undefined;
  private additionalOrbitalCloudOpacity = 0;
  private previouslyInsideCloud = false;
  private readonly sunlight = new THREE.DirectionalLight(0xffe2c1, 1.32);
  private readonly secondarySunlight = new THREE.DirectionalLight(PALETTE.sunRed, 0.56);
  private readonly tertiarySunlight = new THREE.DirectionalLight(0xffd2a1, 0);
  private readonly ambientLight = new THREE.AmbientLight(0x9385df, 0.31);
  private readonly skyLight = new THREE.HemisphereLight(0x713cdf, 0x083a52, 0.13);
  private readonly surfaceFog = new THREE.Fog(0x180b2d, 0.12, 42);

  constructor(parent: HTMLElement) {
    this.parent = parent;
    let savedGraphicsQuality: string | null = null;
    try {
      savedGraphicsQuality = window.localStorage.getItem(GRAPHICS_QUALITY_STORAGE_KEY);
    } catch {
      // High remains usable even when browser preference storage is blocked.
    }
    this.graphicsQuality = resolveGraphicsQualityPreference(window.location.search, savedGraphicsQuality);
    this.gameplayEntered = new URLSearchParams(window.location.search).get('skipIntro') === '1';
    this.loading = document.createElement('div');
    this.loading.className = 'loading';
    this.loading.innerHTML = '<div class="loading-core"><strong>VOID EXPLORER</strong><span>INITIALIZING 2,048 REACHABLE SYSTEMS</span></div>';
    parent.append(this.loading);
    if (!this.gameplayEntered) {
      this.launchScreen = new LaunchScreen(parent, {
        onStart: () => this.enterGame(),
        onOpenDisplaySettings: () => this.openDisplaySettings(),
        isDisplaySettingsOpen: () => this.displaySettings?.isOpen === true,
      });
      this.launchScreen.setLoading('INITIALIZING REACHABLE SYSTEMS');
    }
  }

  async start() {
    try {
      this.host = await RendererHost.create(this.parent, { graphicsQuality: this.graphicsQuality });
      this.gpuTerrain = new GpuTerrainDetail(this.host.renderer);
      const lowerQuality = this.host.capabilities.quality === 'fallback';
      this.terrainJobs = new TerrainJobScheduler({
        maxWorkers: lowerQuality ? 1 : 2,
        maxUploadsPerFrame: lowerQuality ? 1 : 2,
        maxQueued: lowerQuality ? 48 : 64,
        maxPendingBytes: (lowerQuality ? 12 : 20) * 1024 * 1024,
        maxPublicationBytesPerFrame: (lowerQuality ? 2 : 4) * 1024 * 1024,
        useWorkers: true,
      });
      this.contactAuthority = new SurfaceContactAuthority({ quality: lowerQuality ? 'low' : 'high' });
      this.backgroundScene.name = 'Reachable catalog stars and anchored nebula background';
      this.backgroundScene.background = new THREE.Color(PALETTE.void);
      this.scene.background = null;
      this.camera.rotation.order = 'YXZ';
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.scene.add(this.camera);

      this.sunlight.position.set(-0.65, 0.44, 0.76);
      this.sunlight.userData.celestialSourceSlot = 0;
      this.scene.add(this.sunlight);
      this.secondarySunlight.position.set(0.8, 0.28, -0.45);
      this.secondarySunlight.userData.celestialSourceSlot = 1;
      this.scene.add(this.secondarySunlight);
      this.tertiarySunlight.userData.celestialSourceSlot = 2;
      this.scene.add(this.tertiarySunlight);
      this.scene.add(this.ambientLight);
      this.scene.add(this.skyLight);

      const initialPose = this.catalog.evaluateSystem(this.currentSystem, 0).poses.get(this.catalog.heroPlanet.id)!;
      const initialPosition = {
        x: initialPose.localPositionMeters.x + this.catalog.heroPlanet.radiusMeters * 2.85 * 0.676458264,
        y: initialPose.localPositionMeters.y + this.catalog.heroPlanet.radiusMeters * 2.85 * 0.414011177,
        z: initialPose.localPositionMeters.z - this.catalog.heroPlanet.radiusMeters * 2.85 * 0.609096842,
      };
      this.flight = new FlightController({
        catalog: this.catalog,
        system: this.currentSystem,
        initialPosition,
        targetId: this.catalog.heroPlanet.id,
        sampleSurfaceHeightMeters: (planet, direction) => {
          const body = this.bodies.get(planet.id);
          const surface = body?.collision?.sample(direction);
          if (!body || !surface) return 0;
          if (!surface.ocean) return surface.heightMeters;

          const wave = sampleSurfaceOceanWave(
            body.field,
            direction,
            surface.waterDepthMeters,
            this.localEffectsSeconds,
          );
          return Math.max(0, SURFACE_OCEAN_LEVEL_METERS + wave.displacementMeters);
        },
        sampleManualSteeringClearanceMeters: (planet, bodyFixedPositionMeters) => {
          const contact = this.contactAuthority.sample(planet.id, bodyFixedPositionMeters, {
            requireReady: false,
            includeSolids: false,
          });
          return contact ? landingAdmissionClearanceMeters(bodyFixedPositionMeters, planet.radiusMeters, contact) : undefined;
        },
      });
      this.flight.state.yaw = 2.541212215;
      this.flight.state.pitch = -0.192950023;
      this.flight.steer(0, 0);
      this.persistence = new GamePersistence({
        flight: this.flight,
        discoveries: this.discoveries,
        catalog: this.catalog,
      });
      const restored = this.persistence.restore();
      this.celestialTimeScale = restored.celestialTimeScale;
      this.localEffectsSeconds = restored.localEffectsEpochSeconds;
      this.simulationSeconds = restored.simulationEpochSeconds;
      if (restored.restored && restored.system) {
        this.currentSystem = restored.system;
      } else if (this.simulationSeconds !== 0) {
        // A valid universe save may have no usable ship. Keep both clocks and
        // establish the default orbit around the planet at that actual epoch.
        const spawn = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds)
          .poses.get(this.catalog.heroPlanet.id)!;
        const radius = this.catalog.heroPlanet.radiusMeters * 2.85;
        this.flight.restoreState({
          position: serializeAddress(addAddressOffset(this.currentSystem.position, {
            x: spawn.localPositionMeters.x + radius * 0.676458264,
            y: spawn.localPositionMeters.y + radius * 0.414011177,
            z: spawn.localPositionMeters.z - radius * 0.609096842,
          })),
          velocity: vec3(), yaw: 2.541212215, pitch: -0.192950023,
          systemId: this.currentSystem.id, targetId: this.catalog.heroPlanet.id,
        });
      }
      this.flight.snapReferenceFrame(this.simulationSeconds);
      this.simulationClock.reset(this.localEffectsSeconds);

      this.ship = createProceduralShip();
      const authoredShipLoaded = await loadAuroraShip(this.ship, {
        quality: this.host.capabilities.quality,
        maximumTextureAnisotropy: this.host.renderer.getMaxAnisotropy(),
      });
      if (!authoredShipLoaded) {
        const reason = String(this.ship.group.userData.assetError ?? 'unknown asset error');
        throw new Error(`${AURORA_ACTIVE_ASSET.name} spacecraft model failed to load: ${reason}`);
      }
      if (this.host.capabilities.quality === 'fallback') {
        let hiddenTrim = 0;
        this.ship.group.traverse((part) => {
          if (!(part instanceof THREE.Mesh)) return;
          // Keep the complete physical hull, canopy, wingtip beacons, twin
          // nacelles, ion apertures, and plumes. Subpixel secondary trim is
          // individually drawn, so omit it at the genuinely lower resolution.
          if (!part.name || /violet swept outer edge|nested electric-cyan ion focusing stage|Raised ivory dorsal flight spine|octagonal navy rear nozzle shroud|Angular forward ivory navigation chine|Faceted rear fuselage armor/.test(part.name)) {
            part.visible = false;
            hiddenTrim += 1;
          }
        });
        this.ship.group.userData.fallbackHiddenDetails = hiddenTrim;
      }
      this.worldShip = new WorldShipPresentation(this.ship);
      this.scene.add(this.worldShip.root);
      this.surfaceKit = await loadAuroraSurfaceKit({
        quality: this.host.capabilities.quality,
        onError: (error) => { this.surfaceKitError = error.message; },
      });
      if (this.surfaceKit) this.worldShip.installSurfaceKit(this.surfaceKit);
      this.surface = new SurfaceGame({
        flight: this.flight,
        catalog: this.catalog,
        contact: this.contactAuthority,
        scheduler: this.terrainJobs,
        metersPerRenderUnit: METERS_PER_RENDER_UNIT,
        ...(this.surfaceKit ? { kit: this.surfaceKit.manifest } : {}),
        getViewMode: () => this.viewMode,
        restoreViewMode: (view) => { this.setViewMode(view); },
        resolveContactFlowRegion: (lease) => this.resolveContactFlowRegion(lease),
        onContactCommitted: () => this.refreshContactMasks(),
        onRecovery: (reason) => {
          this.resetRenderHistory('recovery');
          this.hud?.notify(`SAFE RECOVERY · ${reason.replaceAll('-', ' ').toUpperCase()}`);
        },
      });
      this.persistence.setSurfaceAdapter(this.surface);
      // An outside save must remain untouched while the hull and surface kit
      // load. Once this adapter exists, pending contact restores block writes.
      if (this.gameplayEntered) this.persistence.attachPagehide(window);
      this.surfaceFx = new SurfaceContactFX(this.host.capabilities.quality);
      this.scene.add(this.surfaceFx.group);
      this.shipOverlay = new ShipOverlay(this.ship, this.camera);
      this.post = new NeonPostProcess(this.host.renderer, this.host.capabilities.quality, {
        // The matched real-frame comparison preserves narrow ship seams
        // better with SMAA. Low keeps native MSAA and the one-pass grade.
        spatialAntialiasing: this.host.capabilities.quality === 'high' ? 'smaa' : 'none',
      });
      try {
        this.neonPhosphorMode = normalizeNeonPhosphorMode(
          window.localStorage.getItem(NEON_PHOSPHOR_STORAGE_KEY),
        );
      } catch {
        this.neonPhosphorMode = DEFAULT_NEON_PHOSPHOR_MODE;
      }
      this.post.setPhosphorMode(this.neonPhosphorMode);

      this.speedField = new SpeedField(this.host.capabilities.quality === 'fallback' ? 256 : 768);
      this.camera.add(this.speedField.group);

      this.hud = new Hud(this.parent);
      this.surfaceOverlay = new SurfaceOverlay(this.parent, {
        onInteract: () => this.interactSurface(),
        onLook: (event) => this.startSurfaceLook(event),
      });
      this.pauseMenu = new PauseMenu(this.parent, {
        onResume: (event) => this.resumeFromPause(event),
        onSettings: () => this.openDisplaySettings(),
        onOpenChange: (open) => this.onPauseMenuOpenChange(open),
      });
      this.displaySettings = new DisplaySettings(this.parent, {
        onApply: (values) => this.applyDisplaySettings(values),
        onOpenChange: (open) => this.onDisplaySettingsOpenChange(open),
      });
      this.hud.onOpenPauseMenu = () => this.openPauseMenu();
      this.cockpitOverlay = new CockpitOverlay(this.parent);
      this.inputRouter = new InputRouter({
        flight: this.flight,
        onFoot: this.surface.session.onFoot,
        owner: this.gameplayEntered ? 'flight' : 'launch',
        onCommand: (command, event) => this.handleInputCommand(command, event),
        clearFlightPointer: () => {
          this.bank = 0;
          this.mouseCaptured = false;
          this.pointerOrigin = undefined;
          this.flight.clearManualSteering();
        },
        getPointerLockElement: () => this.host.renderer.domElement,
        onPointerLockChanged: (locked) => this.onGamePointerLockChanged(locked),
        onOwnerChanged: (owner, previous) => {
          if (owner !== 'onFoot') this.cancelPointerUnlockPause();
          // Egress/boarding completes asynchronously, after the original
          // button or X gesture. Hand keyboard focus to the actual game, but
          // never request pointer lock without a fresh user gesture.
          if (previous === 'transition' &&
              (owner === 'onFoot' || owner === 'parked' || owner === 'flight' || owner === 'cockpit')) {
            this.focusGameCanvas();
          }
        },
      });
      this.hud.onSelect = (id, kind) => this.selectTarget(id, kind);
      this.hud.onApproach = (id, kind) => {
        this.selectTarget(id, kind);
        if (this.requestSurfaceTravel({ kind: 'approach', targetId: id }).accepted) {
          this.hud.notify(kind === 'system' ? 'HYPERDRIVE INTERCEPT LOCKED' : 'PULSE INTERCEPT ENGAGED');
          if (this.hud.isMapOpen?.()) this.hud.toggleMap();
        }
      };
      this.hud.onInspect = (id, kind) => this.selectTarget(id, kind);
      this.buildSystem(this.currentSystem);
      this.prepareSurfaceContact();
      if (this.persistence.pendingSurfaceCheckpoint) this.persistence.restorePendingSurfaceCheckpoint();
      else this.surface.reconcileAfterDiscontinuity(this.simulationSeconds);
      this.resetRenderHistory('initial');
      this.updateMap();
      this.bindEvents();
      window.__VOID_EXPLORER__ = {
        app: this,
        getState: () => this.getState(),
        setDemoState: (state: string) => this.setDemoState(state),
        setCelestialTimeScale: (scale: number) => this.setCelestialTimeScale(scale),
        getCatalog: () => ({ count: this.catalog.count, fingerprint: this.catalog.fingerprint() }),
        engageApproach: (id?: string) => this.requestSurfaceTravel({ kind: 'approach', targetId: id }).accepted,
        requestLanding: () => this.requestLanding(),
        requestTakeoff: () => this.requestTakeoff(),
        requestExit: () => this.requestExit(),
        requestBoard: () => this.requestBoard(),
        getSurfaceState: () => this.getSurfaceState(),
        getPerformanceState: () => this.getPerformanceState(),
        resetPerformanceSamples: () => this.frameTiming.reset(),
        setViewMode: (mode: FlightViewMode) => this.setViewMode(mode),
        setNeonPhosphorMode: (mode: NeonPhosphorMode) => this.setNeonPhosphorMode(mode),
      };
      if (this.persistence.pendingSurfaceCheckpoint) {
        this.launchScreen?.setLoading('RESTORING PHYSICAL SURFACE CONTACT');
      } else {
        this.markLaunchReady();
      }
      this.loading.classList.add('ready');
      this.clock.start();
      this.animate();
    } catch (error) {
      console.error('VoidExplorer failed to initialize', error);
      const message = error instanceof Error ? error.message : String(error);
      this.launchScreen?.setError(message);
      this.loading.querySelector('span')!.textContent = `INITIALIZATION FAILED · ${message}`;
      throw error;
    }
  }

  /** Begin real flight. */
  private enterGame(): void {
    if (this.gameplayEntered || !this.launchScreen?.ready || this.displaySettings?.isOpen) return;
    this.gameplayEntered = true;
    this.syncInputOwner();
    this.persistence.attachPagehide(window);
    this.simulationClock.reset(this.localEffectsSeconds);
    this.launchScreen.dismiss();
    this.focusGameCanvas();
  }

  private markLaunchReady(): void {
    if (this.launchScreen?.ready) return;
    this.launchScreen?.setReady(buildLaunchPresentation(this.catalog, this.discoveries.state), {
      renderer: this.host.capabilities.backend,
    });
  }

  private bindEvents() {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.host.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.host.renderer.domElement.addEventListener('wheel', this.onFlightWheel, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('blur', this.onInputBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
  }

  private readonly onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.host.resize(window.innerWidth, window.innerHeight);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.displaySettings?.isOpen || this.graphicsReloadPending) return;
    if (event.code !== 'Escape') this.syncInputOwner();
    this.inputRouter.handleKeyDown(event);
    if (this.inputRouter.owner === 'flight' || this.inputRouter.owner === 'cockpit') {
      if (event.code === 'KeyA') this.bank = -1;
      if (event.code === 'KeyD') this.bank = 1;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.inputRouter?.handleKeyUp(event);
    if (event.code === 'KeyA' || event.code === 'KeyD') this.bank = 0;
  };

  private readonly onInputBlur = () => {
    this.cancelPointerUnlockPause();
    this.inputRouter?.handleBlur();
  };
  private readonly onPointerLockChange = () => this.inputRouter?.handlePointerLockChange();
  private readonly onPointerLockError = () => this.inputRouter?.handlePointerLockError();

  private focusGameCanvas(): void {
    if (!this.gameplayEntered || this.graphicsReloadPending || this.displaySettings?.isOpen || this.pauseMenu?.isOpen ||
        this.persistence.pendingSurfaceCheckpoint || this.hud.isMapOpen?.() || !document.hasFocus()) return;
    this.host.renderer.domElement.focus({ preventScroll: true });
  }

  private startSurfaceLook(event: MouseEvent): void {
    this.syncInputOwner();
    if (this.inputRouter.owner !== 'onFoot') return;
    this.focusGameCanvas();
    void this.inputRouter.requestPointerLockFromGesture(event).then((locked) => {
      const input = this.inputRouter.snapshot;
      if (!locked && input.owner === 'onFoot' && (input.pointerLockDenied || !input.pointerLockSupported)) {
        this.hud.notify('HOLD LEFT MOUSE TO LOOK · WASD TO WALK');
      }
    });
  }

  private cancelPointerUnlockPause(): void {
    if (this.pointerUnlockPauseFrame === undefined) return;
    cancelAnimationFrame(this.pointerUnlockPauseFrame);
    this.pointerUnlockPauseFrame = undefined;
  }

  private onGamePointerLockChanged(locked: boolean): void {
    this.cancelPointerUnlockPause();
    if (locked || this.inputRouter?.owner !== 'onFoot' || !document.hasFocus()) return;
    // Some browsers consume Escape to release pointer lock instead of sending
    // a key event. Give a delivered Escape first refusal, then open the same
    // menu on an otherwise-unhandled native unlock. Explicit menu operations
    // cancel this frame so one press can never open and immediately close it.
    this.pointerUnlockPauseFrame = requestAnimationFrame(() => {
      this.pointerUnlockPauseFrame = undefined;
      if (this.inputRouter.owner === 'onFoot' && document.hasFocus() &&
          !this.pauseMenu?.isOpen && !this.displaySettings?.isOpen && !this.hud.isMapOpen?.()) {
        this.openPauseMenu();
      }
    });
  }

  private openPauseMenu(): void {
    this.cancelPointerUnlockPause();
    if (!this.gameplayEntered || !this.pauseMenu || this.pauseMenu.isOpen || this.graphicsReloadPending ||
        this.displaySettings?.isOpen || this.persistence.pendingSurfaceCheckpoint) return;
    if (this.hud.isMapOpen?.()) this.hud.toggleMap();
    const bodyId = this.surface.session.actor?.bodyId ?? this.flight.state.landedBodyId;
    const location = bodyId ? this.catalog.getBody(bodyId)?.name
      : this.catalog.getBody(this.flight.state.targetId ?? '')?.name ??
        this.catalog.getSystem(this.flight.state.targetId ?? '')?.name;
    this.pauseMenu.open({
      systemName: this.currentSystem.name,
      location,
      mode: this.surface.session.phase === 'outside' ? 'ON FOOT'
        : this.surface.lifecycle.phase === 'airborne' ? this.flight.state.mode : this.surface.lifecycle.phase,
    });
  }

  private resumeFromPause(event: Event): void {
    this.cancelPointerUnlockPause();
    if (!this.pauseMenu?.isOpen || this.displaySettings?.isOpen || this.graphicsReloadPending) return;
    this.pauseMenu.close();
    this.focusGameCanvas();
    // An explicit Resume click is a fresh gesture. Escape resumes without
    // immediately recapturing a pointer the player just released.
    if (event.isTrusted && event.type === 'click' && this.inputRouter.owner === 'onFoot') {
      void this.inputRouter.requestPointerLockFromGesture(event);
    }
  }

  private onPauseMenuOpenChange(open: boolean): void {
    this.parent.classList.toggle('expedition-paused', open);
    this.cancelPointerUnlockPause();
    if (!this.inputRouter) return;
    if (open) this.inputRouter.setOwner('pause');
    else this.syncInputOwner();
  }

  private syncInputOwner(): void {
    if (!this.inputRouter) return;
    const occupancy = this.surface.session.phase;
    const phase = this.surface.lifecycle.phase;
    const owner: InputOwner = this.displaySettings?.isOpen ? 'settings'
      : !this.gameplayEntered ? 'launch'
        : this.pauseMenu?.isOpen ? 'pause'
          : this.persistence.pendingSurfaceCheckpoint ? 'transition'
            : this.hud.isMapOpen?.() ? 'map'
              : occupancy === 'outside' ? 'onFoot'
                : occupancy !== 'inside' || (phase !== 'airborne' && phase !== 'parked') ? 'transition'
                  : phase === 'parked' ? 'parked'
                    : this.viewMode === 'cockpit' ? 'cockpit' : 'flight';
    this.inputRouter.setOwner(owner);
  }

  private handleInputCommand(command: InputCommand, _event: KeyboardEvent): void {
    if (command === 'launch') { this.enterGame(); return; }
    if (command === 'toggle-settings') { this.openDisplaySettings(); return; }
    if (!this.gameplayEntered) return;
    if (this.persistence.pendingSurfaceCheckpoint) {
      this.reportSurfaceCommand({ accepted: false, reason: 'restoring-surface-contact' });
      return;
    }
    if (command === 'cycle-presentation') {
      this.setNeonPhosphorMode(cycleNeonPhosphorMode(this.neonPhosphorMode));
    } else if (command === 'toggle-view') {
      this.setViewMode(this.viewMode === 'cockpit' ? 'chase' : 'cockpit');
    } else if (command === 'toggle-map') {
      if (!this.hud.isMapOpen?.()) this.updateMap();
      this.hud.toggleMap();
    } else if (command === 'exit-board') {
      this.interactSurface();
    } else if (command === 'landing-takeoff') {
      if (this.surface.lifecycle.phase === 'parked') this.requestTakeoff();
      else if (this.surface.lifecycle.phase === 'airborne') this.requestLanding();
      else this.reportSurfaceCommand(this.surface.cancel());
    } else if (command === 'pulse') {
      this.requestSurfaceTravel(this.flight.state.mode === 'pulse'
        ? { kind: 'pulse' } : { kind: 'approach' });
    } else if (command === 'hyperdrive') {
      const target = this.catalog.getSystem(this.flight.state.targetId ?? '');
      const destination = target ?? (this.currentSystem.id === this.catalog.heroSystem.id
        ? this.catalog.contrastSystem : this.catalog.heroSystem);
      this.requestSurfaceTravel({ kind: 'hyperdrive', systemId: destination.id });
    } else if (command === 'reset') {
      this.resetToStartingOrbit();
    } else if (command === 'celestial-slower' || command === 'celestial-faster') {
      this.setCelestialTimeScale(this.celestialTimeScale + (command === 'celestial-faster' ? 1 : -1));
    } else if (command === 'escape') {
      // Hud may already have consumed Escape to close its map. Do not also
      // open the pause menu because two owners saw the same key.
      if (this.inputRouter.owner === 'map') {
        if (this.hud.isMapOpen?.()) this.hud.toggleMap();
      } else if (this.pauseMenu?.isOpen) this.resumeFromPause(_event);
      else this.openPauseMenu();
    }
    this.syncInputOwner();
  }

  private readonly onFlightWheel = (event: WheelEvent) => {
    if (this.inputRouter.owner !== 'flight' && this.inputRouter.owner !== 'cockpit') return;
    event.preventDefault();
    this.flight.adjustThrottle(-Math.sign(event.deltaY) * 0.12);
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.displaySettings?.isOpen || this.pauseMenu?.isOpen || this.graphicsReloadPending) return;
    if (!this.gameplayEntered) return;
    this.syncInputOwner();
    this.focusGameCanvas();
    if (this.inputRouter.handleOnFootPointerDown(event)) {
      event.preventDefault();
      return;
    }
    if (this.inputRouter.owner !== 'flight' && this.inputRouter.owner !== 'cockpit' &&
        this.inputRouter.owner !== 'parked') return;
    this.mouseCaptured = true;
    this.pointerOrigin = { x: event.clientX, y: event.clientY };
  };
  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.inputRouter?.handleOnFootPointerUp(event)) return;
    const started = this.pointerOrigin;
    this.mouseCaptured = false;
    this.pointerOrigin = undefined;
    if (!started || Math.hypot(event.clientX - started.x, event.clientY - started.y) > 7) return;
    this.selectVisibleObject(event.clientX, event.clientY);
  };
  private readonly onPointerCancel = (event: PointerEvent) => {
    this.inputRouter?.handleOnFootPointerUp(event);
    this.mouseCaptured = false;
    this.pointerOrigin = undefined;
  };
  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.inputRouter?.handlePointerMove(event)) return;
    if (!this.gameplayEntered || !['flight', 'cockpit', 'parked'].includes(this.inputRouter.owner)) return;
    if (this.mouseCaptured) {
      if (this.inputRouter.owner !== 'parked') {
        this.flight.queueManualSteer(-event.movementX * 0.0023, -event.movementY * 0.0018);
      }
      return;
    }
    if (this.hud.isMapOpen?.()) return;
    const now = performance.now();
    if (now - this.lastHoverSample < 72) return;
    this.lastHoverSample = now;
    const hovered = this.pickVisibleObject(event.clientX, event.clientY);
    this.hoveredTargetId = hovered?.id;
    this.host.renderer.domElement.style.cursor = hovered ? 'crosshair' : 'grab';
    if (!hovered) {
      this.hud.setHoverTarget?.();
      return;
    }
    const known = this.sceneTargets.get(hovered.id);
    if (known) {
      this.hud.setHoverTarget?.(known);
      return;
    }
    const body = this.catalog.getBody(hovered.id);
    const system = this.catalog.getSystem(hovered.id);
    const hoveredPose = body ? this.catalog.getBodyPose(body.id, this.simulationSeconds) : undefined;
    const hoveredDistance = hoveredPose
      ? Math.max(0, distanceVec3(hoveredPose.localPositionMeters, this.flight.state.position) - body!.radiusMeters)
      : 0;
    this.hud.setHoverTarget?.({
      id: hovered.id,
      kind: hovered.kind,
      name: body?.name ?? system?.name ?? hovered.id,
      x: event.clientX,
      y: event.clientY,
      visible: true,
      distance: system
        ? formatDistance(Math.hypot(...Object.values(subtractAddresses(system.position, this.flight.state.address))))
        : formatDistance(hoveredDistance),
      label: system ? 'REACHABLE STAR SYSTEM' : this.catalog.getStar(hovered.id) ? 'STELLAR BODY' : 'PROCEDURAL WORLD',
    });
  };

  private selectVisibleObject(clientX: number, clientY: number) {
    const selected = this.pickVisibleObject(clientX, clientY);
    if (selected) this.selectTarget(selected.id, selected.kind);
  }

  private pickVisibleObject(clientX: number, clientY: number): { id: string; kind: 'planet' | 'system' } | undefined {
    const bounds = this.host.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 38;
    raycaster.setFromCamera(pointer, this.camera);

    const selectableBodies = [...this.bodies.values()].filter((body) => body.proxy.visible || body.visibility.object.visible);
    const selectableObjects = selectableBodies.flatMap((body) => [
      ...(body.proxy.visible ? [body.proxy] : []),
      ...(body.visibility.object.visible ? [body.visibility.object] : []),
    ]);
    const planetHits = raycaster.intersectObjects(selectableObjects, false);
    if (planetHits.length > 0) {
      const selected = selectableBodies.find((body) => (
        body.proxy === planetHits[0]!.object || body.visibility.object === planetHits[0]!.object
      ));
      if (selected) return { id: selected.body.id, kind: 'planet' };
    }

    const localStars = raycaster.intersectObjects([...this.stars.values()], true);
    if (localStars.length > 0) {
      let node: THREE.Object3D | null = localStars[0]!.object;
      while (node) {
        const star = [...this.stars.entries()].find(([, group]) => group === node);
        if (star) return { id: star[0], kind: 'planet' };
        node = node.parent;
      }
    }

    const stars = raycaster.intersectObject(this.starfield.points, false);
    const pointIndex = stars[0]?.index;
    if (pointIndex === undefined) return undefined;
    const systemId = this.starfield.systemIds[pointIndex];
    return systemId ? { id: systemId, kind: 'system' } : undefined;
  }

  private buildSystem(system: StarSystem) {
    this.bodyCenterLightingCache.clear();
    // Keep the light layout stable within a system, while omitting work for a
    // tertiary star that does not physically exist in single/binary systems.
    this.tertiarySunlight.visible = system.stars.length > 2;
    for (const body of this.bodies.values()) {
      this.surface?.contacts.removeBodyGroup(body.body.id);
      this.contactAuthority?.unregisterBody(body.body.id);
      this.releaseBodyTerrain(body);
      body.proxyLod.dispose();
      body.visibility.dispose();
      this.disposeBodyRenderResources(body);
      body.weatherNodes.dispose();
      this.scene.remove(body.group);
    }
    this.bodies.clear();
    this.additionalOrbitalCloudBodyId = undefined;
    this.additionalOrbitalCloudOpacity = 0;
    for (const star of this.stars.values()) {
      this.disposeObjectResources(star);
      this.scene.remove(star);
    }
    this.stars.clear();
    if (this.starfield) {
      this.backgroundScene.remove(this.starfield.points);
      this.starfield.dispose();
    }

    this.starfield = new CatalogStars(this.catalog.systems, system.position);
    this.backgroundScene.add(this.starfield.points);
    if (this.nebula) this.backgroundScene.remove(this.nebula);

    this.systemVisualTheme = deriveSystemVisualTheme(system, this.catalog.seed);
    this.systemNebulaVolume = deriveSystemNebulaVolume(system, {
      metersPerRenderUnit: METERS_PER_RENDER_UNIT,
      cameraFarRenderUnits: this.camera.far,
    });
    this.nebula = createNebula(
      system.seed,
      this.starfield.atmosphericTransmittance,
      this.systemVisualTheme,
    );
    this.nebula.scale.setScalar(this.systemNebulaVolume.renderScale);
    this.nebulaAnchorMeters = { ...this.systemNebulaVolume.anchorMeters };
    this.nebula.userData.anchorKind = this.systemNebulaVolume.anchorKind;
    this.nebula.userData.anchorSystemId = system.id;
    this.nebula.userData.anchorEpochSeconds = 0;
    this.nebula.userData.outerRadiusMeters = this.systemNebulaVolume.outerRadiusMeters;
    this.nebula.userData.outerRadiusAu = this.systemNebulaVolume.outerRadiusAu;
    this.nebula.userData.innermostRadiusMeters = this.systemNebulaVolume.innerRadiusMeters;
    this.nebula.userData.outermostOrbitMeters = this.systemNebulaVolume.outermostOrbitMeters;
    this.nebula.userData.worldPhysicalDepthRadiiMeters = (
      this.nebula.userData.physicalDepthRadii as number[]
    ).map((radius) => (
      radius * this.systemNebulaVolume!.renderScale * METERS_PER_RENDER_UNIT
    ));
    this.backgroundScene.add(this.nebula);

    for (const star of system.stars) {
      const group = createStarMesh(star.color, Math.max(star.radiusMeters / METERS_PER_RENDER_UNIT, 14));
      applyStellarSpaceEnvironment(group, star, this.systemVisualTheme);
      group.name = star.name;
      this.stars.set(star.id, group);
      this.scene.add(group);
    }

    for (const planet of system.planets) {
      this.buildPlanet(planet, planet.id === this.catalog.heroPlanet.id);
      for (const moon of planet.moons) this.buildPlanet(moon, false);
    }
  }

  private buildPlanet(planet: PlanetDescriptor, terrainEnabled: boolean) {
    const radius = planet.radiusMeters / METERS_PER_RENDER_UNIT;
    const reducedQuality = this.host.capabilities.quality === 'fallback';
    const field = createPlanetField(planet);
    const weatherField = createPlanetWeather(planet, field);
    const weatherNodes = createPlanetWeatherNodes(weatherField, {
      quality: this.host.capabilities.quality,
      atmosphereColor: planet.atmosphere.color,
    });
    const group = new THREE.Group();
    group.name = `${planet.name} / body-fixed frame`;
    // One live, camera-relative body center keeps every sea-depth calculation
    // identical through orbital motion, origin rebases and patch recenters.
    const oceanDepth = createPlanetOceanDepth(radius, group.position);
    const initialPose = this.catalog.getBodyPose(planet.id, this.simulationSeconds);
    const initialDistanceMeters = initialPose
      ? distanceVec3(initialPose.localPositionMeters, this.flight.state.position)
      : Number.POSITIVE_INFINITY;
    // Never put an unresolved beacon mesh in front of a planet-sized view.
    // System entry already has the authoritative observer/body positions, so
    // prominent worlds start at an adequate silhouette/geography resolution.
    const initialDetail = initialPlanetProxyDetail({
      apparentDiameterPixels: apparentRadiusPixels(this.camera, radius,
        initialDistanceMeters / METERS_PER_RENDER_UNIT, window.innerHeight) * 2,
      distanceRatio: initialDistanceMeters / planet.radiusMeters,
      selected: terrainEnabled || this.flight.state.targetId === planet.id,
      onScreen: true,
    }, reducedQuality);
    const mesh = createPlanetMesh(field, {
      radius,
      detail: initialDetail,
      includeWater: planet.archetype === 'ocean' || planet.archetype === 'temperate',
      flatShading: true,
    });
    const continuityCutoutDirection = new THREE.Vector3(0, 1, 0);
    const continuityCutoutCosine = uniform(2);
    const surfaceCoverageMask = createSurfacePatchCoverageSetMask();
    const orbitalTerrainAlpha = uniform(0);
    const originalMaterial = mesh.material;
    const proxyMaterial = createPlanetLandMaterial(field, {
      bodyPositionMeters: positionLocal.mul(METERS_PER_RENDER_UNIT),
      metersPerRenderUnit: METERS_PER_RENDER_UNIT,
      weatherNodes,
      fusedOceanDepth: true,
      oceanDepth,
      maskNode: surfaceCoverageMask.node.and(
        screenSpaceLodNoise(field.seed).greaterThanEqual(orbitalTerrainAlpha)),
    });
    mesh.material = proxyMaterial as unknown as THREE.MeshLambertMaterial;
    originalMaterial.dispose();
    mesh.userData.continuousSharedFieldBackdrop = true;
    mesh.name = `${planet.name} / cube-sphere terrain`;
    group.add(mesh);
    const effects = createPlanetEffects(planet, radius, {
      proxyGeometry: mesh.geometry,
      field,
      weatherField,
      weatherNodes,
      oceanDepth,
    });
    const proxyLod = new PlanetProxyLod({
      bodyId: planet.id,
      field,
      renderRadius: radius,
      mesh,
      scheduler: this.terrainJobs,
      reducedQuality,
      onGeometryChanged: (geometry) => effects.setProxyGeometry(geometry),
      onTransitionChanged: (transition) => effects.setProxyTransition(transition),
    });
    effects.setProxyTransition(proxyLod.transitionState);
    const visibility = createPlanetVisibility(planet, radius);
    if (planet.archetype === 'ocean' || planet.archetype === 'temperate') group.add(effects.ocean);
    if (weatherField.hasAtmosphere) group.add(effects.atmosphere);
    if (weatherField.supported) group.add(effects.clouds);
    if (weatherField.hasAtmosphere && planet.isLandable) group.add(effects.skyGlow);
    if (effects.rings) group.add(effects.rings);
    group.add(visibility.object);
    const body: BodyVisual = {
      body: planet,
      field,
      weatherField,
      weatherNodes,
      oceanDepth,
      group,
      proxy: mesh,
      proxyLod,
      effects,
      visibility,
      continuityCutoutDirection,
      continuityCutoutCosine,
      surfaceCoverageMask,
      orbitalTerrainAlpha,
    };
    if (planet.isLandable) {
      body.collision = new TerrainCollision(field, { renderRadius: radius });
      this.contactAuthority.registerBody(planet.id, field);
      this.surface.contacts.setBodyPresentation(planet.id, { weatherNodes, ring: planet.ring });
    }
    this.bodies.set(planet.id, body);
    if (planet.isLandable) group.add(this.surface.contacts.getBodyGroup(planet.id));
    this.scene.add(group);
    if (terrainEnabled) {
      const scenario = createHeroScenarios(this.catalog, this.simulationSeconds);
      this.activateBodyTerrain(body, scenario.bodyFixedCoastalDirection);
    }
  }

  private activateBodyTerrain(body: BodyVisual, direction: { x: number; y: number; z: number }) {
    if (!body.body.isLandable || body.streamer) return;
    for (const other of this.bodies.values()) {
      if (other !== body && other.streamer) this.releaseBodyTerrain(other);
    }

    const radius = body.body.radiusMeters / METERS_PER_RENDER_UNIT;
    const reducedQuality = this.host.capabilities.quality === 'fallback';
    const layout = createSurfaceDetailLayout(body.body.radiusMeters, reducedQuality,
      body.body.atmosphere.heightMeters, body.body.atmosphere.density);
    body.surfaceLayout = layout;
    body.streamer = new TerrainStreamer(body.field, {
      scheduler: this.terrainJobs,
      managedPresentation: true,
      materialFactory: ({ bodyPositionRenderUnits, maskNode }) => createPlanetLandMaterial(body.field, {
        bodyPositionMeters: bodyPositionRenderUnits.mul(METERS_PER_RENDER_UNIT),
        metersPerRenderUnit: METERS_PER_RENDER_UNIT,
        weatherNodes: body.weatherNodes,
        orbitalWater: body.field.archetype === 'ocean' || body.field.archetype === 'temperate',
        fusedOceanDepth: true,
        oceanDepth: body.oceanDepth,
        maskNode,
      }),
      renderRadius: radius,
      maxDepth: 18,
      maxTiles: reducedQuality ? 32 : 64,
      maxResident: reducedQuality ? 56 : 96,
      maxQueued: reducedQuality ? 24 : 36,
      maxWorkers: reducedQuality ? 1 : 2,
      tileSegments: 32,
      maxUploadsPerFrame: reducedQuality ? 1 : 2,
      fadeDurationSeconds: reducedQuality ? 0.44 : 0.36,
      predictionSeconds: reducedQuality ? 0.65 : 0.82,
      viewportHeight: window.innerHeight,
      prewarmDistanceRatio: 3.1,
      useWorkers: true,
    });
    body.group.add(body.streamer.group);
    body.streamer.group.userData.planetField = body.field;
    body.streamer.group.visible = false;
    if (body.effects.clouds.parent !== body.group) body.group.add(body.effects.clouds);

    const patches = layout.map((layer, index) => {
      const patch: SurfacePatch = createSurfacePatch(body.field, {
        renderRadius: radius,
        weatherNodes: body.weatherNodes,
        oceanDepth: body.oceanDepth,
        direction,
        size: layer.widthMeters / METERS_PER_RENDER_UNIT,
        segments: layer.segments,
        mineralCount: layer.minerals,
        outcropCount: layer.outcrops,
        scheduler: this.terrainJobs,
        deferGeometry: true,
        canCommit: () => this.lastSurfacePatchCommitFrame !== this.frame &&
          // First coverage must never wait for decoration or a recenter fade.
          // Replacements share one bounded retiring land/water pair per body.
          (!patch.hasGeometry || ![body.surfacePatch, ...(body.surfaceDetails ?? [])]
            .some((candidate) => candidate?.replacementTransitioning)),
        onCommitted: (committed) => {
          this.lastSurfacePatchCommitFrame = this.frame;
          // A newly uploaded patch must inherit current contact ownership
          // before it can become visible, including an already parked actor.
          committed.setContactExclusions(this.contactAuthority.getActiveGenerations(body.body.id));
        },
        getContactFlowRegion: () => this.contactAuthority.statuses.some((status) => status.lease.bodyId === body.body.id)
          ? this.contactAuthority.getFlowRegion(body.body.id) : null,
        hasContactLeases: () => this.contactAuthority.statuses.some((status) => status.lease.bodyId === body.body.id),
      });
      if (index > 0) patch.name = `${body.body.name} / coastal detail level ${index}`;
      patch.userData.surfaceDetailLayer = layer.name;
      patch.userData.fullBelowGroundMeters = layer.fullBelowMeters;
      patch.userData.hiddenAboveGroundMeters = layer.hiddenAboveMeters;
      this.configurePatchDepth(patch, index);
      patch.setContactExclusions(this.contactAuthority.getActiveGenerations(body.body.id));
      patch.setPresentation(0);
      patch.visible = false;
      body.group.add(patch);
      return patch;
    });
    body.surfacePatch = patches[0]!;
    body.surfaceDetails = patches.slice(1);
  }

  private releaseBodyTerrain(body: BodyVisual) {
    if (body.streamer) {
      this.gpuTerrain?.release();
      body.streamer.dispose();
      body.group.remove(body.streamer.group);
      body.streamer = undefined;
    }
    if (body.surfacePatch) {
      body.surfacePatch.dispose();
      body.group.remove(body.surfacePatch);
      body.surfacePatch = undefined;
    }
    for (const patch of body.surfaceDetails ?? []) {
      patch.dispose();
      body.group.remove(patch);
    }
    body.surfaceDetails = undefined;
    body.surfaceLayout = undefined;
    body.surfaceGroundClearanceMeters = undefined;
    // This body may already have been processed this frame when another
    // body's approach takes the terrain budget. Restore its complete globe
    // immediately, not on the following frame after its patches are gone.
    body.continuityCutoutCosine.value = 2;
    body.orbitalTerrainAlpha.value = 0;
    body.surfaceCoverageMask.set([], { originBodyFixedMeters: vec3(), metersPerLocalUnit: METERS_PER_RENDER_UNIT });
    body.effects.setSurfaceCoverage([]);
    body.effects.setSurfaceCutout(body.continuityCutoutDirection, 2);
    body.proxy.visible = true;
    body.effects.ocean.visible = body.effects.ocean.userData.physicalWaterSupported === true;
  }

  private updateMap(currentSnapshot?: SystemSnapshot) {
    const snapshot = currentSnapshot ?? this.catalog.evaluateSystem(
      this.currentSystem,
      this.simulationSeconds,
    );
    this.lastMapRefreshLocalSeconds = this.localEffectsSeconds;
    const entries: RichMapEntry[] = [];
    for (const planet of this.currentSystem.planets) {
      const pose = snapshot.poses.get(planet.id);
      const orbitParentPose = snapshot.poses.get(planet.orbit.parentId);
      const orbitalMotion = pose
        ? measureOrbitalMotion(
          planet.orbit,
          pose.localPositionMeters,
          orbitParentPose?.localPositionMeters,
        )
        : undefined;
      entries.push({
        id: planet.id,
        name: planet.name,
        detail: `${planet.archetype.replace('-', ' ')} · ${planet.ring ? 'RINGED · ' : ''}${planet.isLandable ? 'LANDABLE' : 'GAS GIANT'}`,
        kind: 'planet',
        orbitalRadiusAu: planet.orbit.semiMajorAxisMeters / AU_METERS,
        orbitalPhase: orbitalMotion?.orbitalPhaseRadians ?? 0,
        orbitalPeriodSeconds: planet.orbit.periodSeconds,
        eccentricity: planet.orbit.eccentricity,
        inclinationRadians: planet.orbit.inclinationRadians,
        longitudeAscendingNodeRadians: planet.orbit.longitudeAscendingNodeRadians,
        argumentPeriapsisRadians: planet.orbit.argumentPeriapsisRadians,
        ...(orbitalMotion
          ? { orbitalSpeedMetersPerSecond: orbitalMotion.orbitalSpeedMetersPerSecond }
          : {}),
        rotationPeriodSeconds: planet.rotationPeriodSeconds,
        surfaceGravity: planet.surfaceGravity,
        massKg: planet.massKg,
        moonCount: planet.moons.length,
        isLandable: planet.isLandable,
        radiusMeters: planet.radiusMeters,
        color: planet.colors.shallow ?? planet.colors.atmosphere,
        ringed: Boolean(planet.ring),
        distanceMeters: pose
          ? Math.max(0, distanceVec3(pose.localPositionMeters, this.flight.state.position) - planet.radiusMeters)
          : 0,
        ...(pose ? { position: {
          x: pose.localPositionMeters.x / AU_METERS,
          y: pose.localPositionMeters.z / AU_METERS,
          z: pose.localPositionMeters.y / AU_METERS,
        } } : {}),
      });
      for (const moon of planet.moons) {
        const moonPose = snapshot.poses.get(moon.id);
        const moonMotion = moonPose && pose
          ? measureOrbitalMotion(
            moon.orbit,
            moonPose.localPositionMeters,
            pose.localPositionMeters,
          )
          : undefined;
        entries.push({
          id: moon.id,
          name: moon.name,
          detail: `MOON OF ${planet.name.toUpperCase()} · ${moon.archetype.replace('-', ' ')} · LANDABLE`,
          kind: 'planet',
          parentId: planet.id,
          isMoon: true,
          orbitalRadiusAu: moon.orbit.semiMajorAxisMeters / AU_METERS,
          orbitalPhase: moonMotion?.orbitalPhaseRadians ?? 0,
          orbitalPeriodSeconds: moon.orbit.periodSeconds,
          eccentricity: moon.orbit.eccentricity,
          inclinationRadians: moon.orbit.inclinationRadians,
          longitudeAscendingNodeRadians: moon.orbit.longitudeAscendingNodeRadians,
          argumentPeriapsisRadians: moon.orbit.argumentPeriapsisRadians,
          ...(moonMotion
            ? { orbitalSpeedMetersPerSecond: moonMotion.orbitalSpeedMetersPerSecond }
            : {}),
          rotationPeriodSeconds: moon.rotationPeriodSeconds,
          surfaceGravity: moon.surfaceGravity,
          massKg: moon.massKg,
          moonCount: moon.moons.length,
          isLandable: moon.isLandable,
          radiusMeters: moon.radiusMeters,
          color: moon.colors.atmosphere ?? moon.colors.shallow,
          distanceMeters: moonPose
            ? Math.max(0, distanceVec3(moonPose.localPositionMeters, this.flight.state.position) - moon.radiusMeters)
            : 0,
          ...(moonPose ? { position: {
            x: moonPose.localPositionMeters.x / AU_METERS,
            y: moonPose.localPositionMeters.z / AU_METERS,
            z: moonPose.localPositionMeters.y / AU_METERS,
          } } : {}),
        });
      }
    }
    if (this.mapNearbySystemId !== this.currentSystem.id) {
      this.mapNearbySystemId = this.currentSystem.id;
      this.mapNearbySystems = this.catalog.nearestSystems(this.currentSystem.position, 97);
    }
    for (const item of this.mapNearbySystems) {
      if (item.system.id === this.currentSystem.id) continue;
      const relative = subtractAddresses(item.system.position, this.currentSystem.position);
      const relativeToShip = subtractAddresses(item.system.position, this.flight.state.address);
      const distanceMeters = Math.hypot(relativeToShip.x, relativeToShip.y, relativeToShip.z);
      entries.push({
        id: item.system.id,
        name: item.system.name,
        detail: `${item.system.kind.toUpperCase()} · ${formatDistance(distanceMeters)}`,
        kind: 'system',
        distanceMeters,
        color: item.system.stars[0]?.color,
        starCount: item.system.stars.length,
        spectralClass: item.system.stars[0]?.spectralType,
        position: {
          x: relative.x / LIGHT_YEAR_METERS,
          y: relative.z / LIGHT_YEAR_METERS,
          z: relative.y / LIGHT_YEAR_METERS,
        },
      });
    }
    if (this.hud.setMapLayout) {
      this.hud.setMapLayout({
        systemId: this.currentSystem.id,
        systemName: this.currentSystem.name,
        systemKind: this.currentSystem.kind,
        simulationEpochSeconds: this.simulationSeconds,
        celestialTimeScale: this.celestialTimeScale,
        shipPosition: {
          x: this.flight.state.position.x / AU_METERS,
          y: this.flight.state.position.z / AU_METERS,
          z: this.flight.state.position.y / AU_METERS,
        },
        shipVelocityMetersPerSecond: this.flight.state.speedMetersPerSecond,
        shipHeadingRadians: Math.atan2(
          this.flight.state.forward.z,
          this.flight.state.forward.x,
        ),
        stars: snapshot.stars.map((pose, index) => {
          const star = this.catalog.getStar(pose.id)!;
          const stellarSeparationMeters = index === 2
            ? this.currentSystem.outerSeparationMeters
            : this.currentSystem.binarySeparationMeters;
          const stellarParentMassKg = index === 2
            ? this.currentSystem.stars.reduce((mass, candidate) => mass + candidate.massKg, 0)
            : (this.currentSystem.stars[0]?.massKg ?? 0) +
              (this.currentSystem.stars[1]?.massKg ?? 0);
          const stellarOrbitalPeriodSeconds = star.orbit?.periodSeconds ?? (
            stellarSeparationMeters && stellarParentMassKg > 0
              ? orbitalPeriodSeconds(stellarSeparationMeters, stellarParentMassKg)
              : undefined
          );
          return {
            id: star.id,
            name: star.name,
            color: star.color,
            radius: star.radiusMeters,
            radiusMeters: star.radiusMeters,
            spectralClass: `${star.spectralType}${star.spectralSubtype}`,
            temperatureKelvin: star.temperatureKelvin,
            massKg: star.massKg,
            luminositySolar: star.luminositySolar,
            ...(stellarOrbitalPeriodSeconds
              ? { orbitalPeriodSeconds: stellarOrbitalPeriodSeconds }
              : {}),
            distanceMeters: Math.max(
              0,
              distanceVec3(pose.localPositionMeters, this.flight.state.position) - star.radiusMeters,
            ),
            position: {
              x: pose.localPositionMeters.x / AU_METERS,
              y: pose.localPositionMeters.z / AU_METERS,
              z: pose.localPositionMeters.y / AU_METERS,
            },
          };
        }),
        entries,
        activeTargetId: this.flight.state.targetId,
      });
      return;
    }
    this.hud.setMapEntries(entries);
  }

  private selectTarget(id: string, kind: 'planet' | 'system') {
    this.flight.setTarget(id);
    if (kind === 'planet') this.discoveries.discoverBody(id);
    this.persistence.saveActiveWaypoint(id, this.simulationSeconds);
    this.hud.setTargetLock?.(id);
    if (this.viewMode === 'cockpit') {
      const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds);
      this.updateCockpitRadar(snapshot);
      this.updateHud(snapshot.poses);
    }
    this.hud.notify(`WAYPOINT LOCKED · ${(this.catalog.getBody(id)?.name ?? this.catalog.getSystem(id)?.name ?? id).toUpperCase()}`);
  }

  /** Freeze only simulation truth; rendering never writes these poses back. */
  private captureRenderFrame(): SimulationRenderFrame {
    const state = this.flight.state;
    const surfaceBodyId = state.surfacePhase !== 'airborne'
      ? state.landedBodyId ?? state.parkedAnchor?.bodyId ?? state.nearestBodyId
      : undefined;
    const body = surfaceBodyId ? this.catalog.getBodyPose(surfaceBodyId, this.simulationSeconds) : undefined;
    const bodyFixed = body ? {
      bodyId: body.id,
      positionMeters: worldToBodyFixed({ id: body.id, origin: body.position, rotationRadians: body.rotationRadians }, state.address),
      forward: rotateAroundYAxis(state.forward, -body.rotationRadians),
      up: rotateAroundYAxis(state.referenceUp, -body.rotationRadians),
    } : undefined;
    const occupancy = this.surface?.session.snapshot;
    const actorBodyId = occupancy?.transition?.bodyId ?? occupancy?.actor?.bodyId;
    const actorBody = actorBodyId ? this.catalog.getBodyPose(actorBodyId, this.simulationSeconds) : undefined;
    const actorFrame = actorBody ? {
      id: actorBody.id, origin: actorBody.position, rotationRadians: actorBody.rotationRadians,
    } : undefined;
    const actorEye = actorFrame ? this.surface.getObserverPose(actorFrame) : undefined;
    const actor: CanonicalRenderPose | undefined = actorEye && actorFrame ? {
      address: actorEye.address,
      forward: actorEye.forward,
      up: actorEye.up,
      velocityMetersPerSecond: occupancy?.actor
        ? rotateAroundYAxis(occupancy.actor.bodyFixedVelocityMetersPerSecond, actorFrame.rotationRadians) : vec3(),
      rollRadians: 0,
      frameId: `surface-actor:${actorFrame.id}`,
      bodyFixed: {
        bodyId: actorFrame.id,
        positionMeters: occupancy?.transition?.eyeBodyFixedMeters ?? worldToBodyFixed(actorFrame, actorEye.address),
        forward: rotateAroundYAxis(actorEye.forward, -actorFrame.rotationRadians),
        up: rotateAroundYAxis(actorEye.up, -actorFrame.rotationRadians),
      },
    } : undefined;
    return {
      systemId: state.systemId,
      simulationTimeSeconds: this.localEffectsSeconds,
      celestialTimeSeconds: this.simulationSeconds,
      ship: {
        address: cloneAddress(state.address),
        forward: { ...state.forward },
        up: { ...state.referenceUp },
        velocityMetersPerSecond: { ...state.velocity },
        rollRadians: state.roll,
        frameId: body ? `body:${body.id}` : `system:${state.systemId}`,
        ...(bodyFixed ? { bodyFixed } : {}),
      },
      ...(actor ? { actor } : {}),
    };
  }

  private resetRenderHistory(reason: CameraDiscontinuityReason): void {
    this.renderHistory.reset(this.captureRenderFrame());
    this.renderInterpolation = 1;
    this.flightCamera.reset(reason);
  }

  private resolveRenderPose(pose: CanonicalRenderPose, epoch: number): CanonicalRenderPose {
    const local = pose.bodyFixed;
    const body = local ? this.catalog.getBodyPose(local.bodyId, epoch) : undefined;
    if (!local || !body) return pose;
    return {
      ...pose,
      address: bodyFixedToWorld({ id: body.id, origin: body.position, rotationRadians: body.rotationRadians }, local.positionMeters),
      forward: rotateAroundYAxis(local.forward, body.rotationRadians),
      up: rotateAroundYAxis(local.up, body.rotationRadians),
    };
  }

  private updateRenderObserver(deltaSeconds: number): void {
    const frame = this.renderHistory.sample(this.renderInterpolation);
    if (!frame) return;
    this.renderSnapshot = frame;
    this.renderEpochSeconds = frame.celestialTimeSeconds;
    this.renderLocalEffectsSeconds = frame.simulationTimeSeconds;
    const ship = this.resolveRenderPose(frame.ship, frame.celestialTimeSeconds);
    this.renderShipPose = ship;
    let observer: ActiveObserverPose;
    const actor = frame.actor ? this.resolveRenderPose(frame.actor, frame.celestialTimeSeconds) : undefined;
    const actorOwnsView = actor && ['egressing', 'outside', 'boarding'].includes(this.surface.session.phase);
    if (actorOwnsView) {
      observer = createRigidObserverPose('surface-actor', actor);
      this.renderObserverVelocity = { ...actor.velocityMetersPerSecond };
    } else if (this.viewMode === 'cockpit') {
      const eye = resolveCockpitCameraPresentation({
        forward: ship.forward,
        referenceUp: ship.up,
        assetScale: 1,
        pilotEyeMeters: this.surfaceKit?.manifest.pilotEyeMeters,
        rollRadians: ship.rollRadians,
      });
      const basis = rollObserverBasis(orthonormalObserverBasis(ship.forward, ship.up), ship.rollRadians);
      observer = createRigidObserverPose('ship-cockpit', {
        address: addAddressOffset(ship.address, eye.eyeOffsetMeters),
        ...basis,
      }, { fovDegrees: eye.fieldOfViewDegrees });
      this.renderObserverVelocity = { ...ship.velocityMetersPerSecond };
    } else {
      observer = this.flightCamera.update({
        shipAddress: ship.address,
        forward: ship.forward,
        referenceUp: ship.up,
        surfaceUp: this.flight.state.surfaceUp,
        surfaceInfluence: this.flight.state.surfaceInfluence,
        velocityMetersPerSecond: ship.velocityMetersPerSecond,
        rollRadians: ship.rollRadians,
        mode: this.flight.state.mode,
        surfacePhase: this.flight.state.surfacePhase,
        clearanceMeters: this.surface.lifecycle.phase === 'airborne'
          ? this.altitudeMeters : this.surface.lifecycle.snapshot.clearanceMeters,
        throttle: this.flight.state.throttle,
        deltaSeconds,
        sweepBoom: (sweep) => this.sweepCameraBoom(sweep),
      });
      this.renderObserverVelocity = { ...ship.velocityMetersPerSecond };
    }
    this.previousCameraQuaternion.copy(this.camera.quaternion);
    this.activeObserver = observer;
    this.renderObserverPosition = subtractAddresses(observer.address, this.currentSystem.position);
    // Camera offsets belong to the same interpolated epoch as the rendered
    // ship; comparing with the latest orbiting simulation pose adds orbital
    // travel to what should be a bounded meter-scale cockpit/chase offset.
    this.cameraViewOffset = subtractAddresses(observer.address, ship.address);
    this.cameraReferenceUp.set(observer.up.x, observer.up.y, observer.up.z);
    applyObserverPose(this.camera, observer);
    const cockpitVisible = observer.owner === 'ship-cockpit';
    this.shipOverlay.setCockpitMode(cockpitVisible);
    this.cockpitOverlay.setActive(cockpitVisible);
    this.hud.setCockpitMode(cockpitVisible);
    this.hud.setOnFootMode(observer.owner === 'surface-actor');
    this.cameraAngularDelta = this.previousCameraQuaternion.angleTo(this.camera.quaternion);
  }

  /** A physical sphere sweep protects the chase eye, never the ship's trajectory. */
  private sweepCameraBoom(sweep: CameraBoomSweep) {
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.renderEpochSeconds);
    const origin = subtractAddresses(sweep.fromAddress, this.currentSystem.position);
    const nearby = this.nearestLandableBody(snapshot.poses, origin);
    if (!nearby || nearby.altitudeMeters > 2_500) return { safeFraction: 1 };
    const frame = { id: nearby.pose.id, origin: nearby.pose.position, rotationRadians: nearby.pose.rotationRadians };
    const result = this.contactAuthority.sweepCapsule(nearby.pose.id,
      worldToBodyFixed(frame, sweep.fromAddress), worldToBodyFixed(frame, sweep.toAddress), {
        radiusMeters: sweep.radiusMeters,
        requireReady: false,
        includeSolids: true,
        blockHazards: false,
      });
    return {
      safeFraction: result.safeFraction,
      address: bodyFixedToWorld(frame, { ...result.positionBodyFixedMeters }),
    };
  }

  private animate = () => {
    const frameCpuStarted = performance.now();
    const rawDelta = this.clock.getDelta();
    const delta = Math.min(rawDelta, 0.05);
    const simulationRunning = this.gameplayEntered && !this.displaySettings?.isOpen && !this.pauseMenu?.isOpen &&
      !this.graphicsReloadPending && !this.persistence.pendingSurfaceCheckpoint;
    const effectsDelta = simulationRunning ? delta : 0;
    this.terrainJobs.beginFrame(this.frame);
    const hadPendingRestore = Boolean(this.persistence.pendingSurfaceCheckpoint);
    this.surface.serviceReadiness(this.frame);
    if (hadPendingRestore && this.persistence.restorePendingSurfaceCheckpoint()) {
      this.resetRenderHistory('restore');
      this.markLaunchReady();
    }
    this.syncInputOwner();
    const previousSystemId = this.flight.state.systemId;
    let completedFtlArrival = false;
    if (simulationRunning) {
      const stepped = this.simulationClock.advance(delta, (stepSeconds, localEffectsSeconds) => {
        this.localEffectsSeconds = localEffectsSeconds;
        this.simulationSeconds += stepSeconds * this.celestialTimeScale;
        const previousOccupancy = this.surface.session.phase;
        const previousTravelMode = this.flight.state.mode;
        const previousTravelProgress = this.flight.state.travelProgress;
        this.surface.step(stepSeconds, this.simulationSeconds);
        // Completion, unlike cancellation or an obstructed route, commits
        // travelProgress=1. Reset once at the final pose of this render tick.
        completedFtlArrival ||= (previousTravelMode === 'pulse' || previousTravelMode === 'hyperdrive') &&
          previousTravelProgress < 1 && this.flight.state.mode === 'cruise' &&
          this.flight.state.phase === 'idle' && this.flight.state.travelProgress === 1;
        const occupancy = this.surface.session.phase;
        if (occupancy !== previousOccupancy && (occupancy === 'egressing' || occupancy === 'inside')) {
          this.resetRenderHistory(occupancy === 'egressing' ? 'egress' : 'boarding');
        } else {
          this.renderHistory.push(this.captureRenderFrame());
        }
      });
      this.renderInterpolation = stepped.interpolation;
      const departurePhase = this.flight.getGuidance()?.departurePhase;
      if (departurePhase && departurePhase !== this.lastAutopilotPhase) {
        const message = departurePhase === 'launching'
          ? 'AUTOPILOT · CLIMBING TO SAFE ORBIT'
          : departurePhase === 'clearing'
            ? 'AUTOPILOT · NAVIGATING AROUND PLANET'
            : 'AUTOPILOT · ALIGNING WITH DESTINATION';
        this.hud.notify(message);
      }
      this.lastAutopilotPhase = departurePhase;
      this.persistence.update(this.simulationSeconds, Date.now(), this.localEffectsSeconds);
    }
    if (this.flight.state.systemId !== previousSystemId) {
      this.currentSystem = this.catalog.requireSystem(this.flight.state.systemId);
      this.discoveries.discoverSystem(this.currentSystem.id);
      this.surface.reconcileAfterDiscontinuity(this.simulationSeconds);
      this.buildSystem(this.currentSystem);
      this.resetRenderHistory('system-switch');
      this.updateMap();
      this.hud.notify(`${this.currentSystem.name.toUpperCase()} · ARRIVAL COMPLETE`);
    } else if (completedFtlArrival) {
      this.resetRenderHistory('ftl-arrival');
    }

    this.updateRenderObserver(effectsDelta);
    if (this.activeObserver) this.starfield.setObserverAddress(this.activeObserver.address);
    this.syncInputOwner();
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.renderEpochSeconds);
    const nearest = this.nearestLandableBody(snapshot.poses, this.renderObserverPosition);
    const nearSurface = nearest && nearest.altitudeMeters < Math.max(220_000, nearest.visual.body.atmosphere.heightMeters * 1.25);
    const nearestRadial = nearest
      ? new THREE.Vector3(
        this.renderObserverPosition.x - nearest.pose.localPositionMeters.x,
        this.renderObserverPosition.y - nearest.pose.localPositionMeters.y,
        this.renderObserverPosition.z - nearest.pose.localPositionMeters.z,
      )
      : undefined;
    const observedWeather = nearest && nearestRadial
      ? nearest.visual.effects.setObserver(
        nearestRadial.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -nearest.pose.rotationRadians).normalize(),
        nearestRadial.length() - nearest.visual.body.radiusMeters,
        this.renderLocalEffectsSeconds,
      )
      : undefined;
    const observerSurfaceNormal = nearSurface && nearestRadial
      ? nearestRadial.clone().normalize()
      : undefined;
    const observerAtmosphereDensity = nearSurface && nearest
      ? THREE.MathUtils.clamp(
        observedWeather?.atmosphericDensity ?? sampleAtmosphereDensity(
          nearest.visual.body.atmosphere,
          (nearestRadial?.length() ?? Number.POSITIVE_INFINITY) - nearest.visual.body.radiusMeters,
        ),
        0,
        1,
      )
      : 0;
    const celestialLighting = evaluateCelestialLighting(snapshot, {
      positionMeters: this.renderObserverPosition,
      ...(nearSurface && nearest && observerSurfaceNormal
        ? {
          body: nearest.visual.body,
          bodyPose: nearest.pose,
          surfaceNormalWorld: {
            x: observerSurfaceNormal.x,
            y: observerSurfaceNormal.y,
            z: observerSurfaceNormal.z,
          },
          atmosphereDensity: observerAtmosphereDensity,
          atmosphericHumidity: observedWeather?.localMoisture ?? 0,
        }
        : {}),
      includeEclipses: true,
    });
    this.celestialLightingFrame = celestialLighting;
    if (observedWeather?.bodyId !== this.previousCloudBodyId) {
      this.previousCloudBodyId = observedWeather?.bodyId;
      this.previouslyInsideCloud = false;
    }
    if (observedWeather?.insideCloud && !this.previouslyInsideCloud) this.cloudCrossings += 1;
    this.previouslyInsideCloud = observedWeather?.insideCloud ?? false;
    let surfaceAtmosphereFactor = 0;
    if (nearSurface && nearest) {
      const focusedPose = nearest.pose;
      const focusedBody = nearest.visual.body;
      const radial = new THREE.Vector3(
        this.renderObserverPosition.x - focusedPose.localPositionMeters.x,
        this.renderObserverPosition.y - focusedPose.localPositionMeters.y,
        this.renderObserverPosition.z - focusedPose.localPositionMeters.z,
      ).normalize();
      const radialDistance = distanceVec3(focusedPose.localPositionMeters, this.renderObserverPosition);
      const physicalAltitude = Math.max(0, radialDistance - focusedBody.radiusMeters);
      const atmosphereFactor = hasRenderableAtmosphere(focusedBody.atmosphere) ? THREE.MathUtils.clamp(
        1 - physicalAltitude / Math.max(1, focusedBody.atmosphere.heightMeters * 1.16),
        0,
        1,
      ) * atmosphereSurfaceDensity(focusedBody.atmosphere) : 0;
      surfaceAtmosphereFactor = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(atmosphereFactor, observedWeather?.atmosphericDensity ?? atmosphereFactor, 0.32),
        0,
        1,
      );
      const daylight = celestialLighting.daylight;
      const twilight = celestialLighting.twilight;
      const localCloudDensity = observedWeather?.cloudDensity ?? 0;
      const atmosphericHaze = THREE.MathUtils.smoothstep(surfaceAtmosphereFactor, 0.2, 0.82);
      const dominantSource = celestialLighting.dominantSlot >= 0
        ? celestialLighting.sources[celestialLighting.dominantSlot]
        : undefined;
      this.surfaceFog.color.set(0x160a27)
        .lerp(new THREE.Color(focusedBody.colors.atmosphere), 0.15 + daylight * 0.16)
        .lerp(new THREE.Color(focusedBody.colors.accent), (twilight * 0.22 + (1 - daylight) * 0.055) * surfaceAtmosphereFactor)
        .lerp(
          new THREE.Color(dominantSource?.colorHex ?? focusedBody.colors.atmosphere),
          twilight * surfaceAtmosphereFactor * 0.14,
        )
        .lerp(new THREE.Color(focusedBody.colors.atmosphere), localCloudDensity * 0.055);
      this.surfaceFog.near = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(0.52, 0.068, atmosphericHaze),
        0.028,
        localCloudDensity * 0.72,
      );
      this.surfaceFog.far = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(42, 1.32, atmosphericHaze),
        0.78,
        localCloudDensity * 0.68,
      );
      this.scene.fog = surfaceAtmosphereFactor > 0.012 || localCloudDensity > 0.025 ? this.surfaceFog : null;
      this.skyLight.position.copy(radial);
    } else {
      this.scene.fog = null;
    }
    // The real world-space hull shares these existing environment lights with
    // the terrain. Source-colored, nearly neutral daylight preserves its ivory
    // ceramic; genuine night retains the restrained indigo visibility floor.
    const indirect = resolveWorldIndirectLighting(celestialLighting, {
      nearSurface: Boolean(nearSurface),
      atmosphereFactor: surfaceAtmosphereFactor,
      cloudDensity: observedWeather?.cloudDensity ?? 0,
    });
    this.ambientLight.color.setRGB(indirect.ambientColor.r, indirect.ambientColor.g, indirect.ambientColor.b);
    this.ambientLight.intensity = indirect.ambientIntensity;
    this.skyLight.color.setRGB(indirect.skyColor.r, indirect.skyColor.g, indirect.skyColor.b);
    this.skyLight.groundColor.setRGB(indirect.groundColor.r, indirect.groundColor.g, indirect.groundColor.b);
    this.skyLight.intensity = indirect.skyIntensity;
    if (!nearSurface) {
      this.skyLight.position.set(indirect.sourceDirectionWorld.x, indirect.sourceDirectionWorld.y, indirect.sourceDirectionWorld.z);
    }
    this.currentAtmosphereFactor = surfaceAtmosphereFactor;
    // Preserve every real catalog identity and anchored gas formation while
    // their light physically attenuates through the actual local atmosphere.
    this.starfield.setAtmosphericLighting(
      surfaceAtmosphereFactor,
      celestialLighting.daylight,
      observedWeather?.opticalDepth ?? 0,
    );

    if (this.nebula) {
      this.nebula.position.set(
        (this.nebulaAnchorMeters.x - this.renderObserverPosition.x) / METERS_PER_RENDER_UNIT,
        (this.nebulaAnchorMeters.y - this.renderObserverPosition.y) / METERS_PER_RENDER_UNIT,
        (this.nebulaAnchorMeters.z - this.renderObserverPosition.z) / METERS_PER_RENDER_UNIT,
      );
    }

    this.currentTerrainTransition = 0;
    this.updateStellarLighting(celestialLighting);
    const observerRadialLength = nearestRadial?.length() ?? 0;
    for (const pose of snapshot.stars) {
      const star = this.stars.get(pose.id);
      this.updateBodyPosition(star, pose);
      const source = celestialLighting.sources.find((entry) => entry.active && entry.id === pose.id);
      if (star && source) {
        star.userData.celestialLightSourceId = source.id;
        star.userData.celestialVisibility = source.visibility;
        star.userData.celestialIrradianceSolar = source.receivedIrradianceSolar;
      }
      const setAtmosphericScattering = star?.userData.setAtmosphericScattering as
        ((amount: number) => void) | undefined;
      if (!setAtmosphericScattering) continue;
      if (!nearest || !nearestRadial || observerRadialLength === 0) {
        setAtmosphericScattering(0);
        continue;
      }

      const starwardX = pose.localPositionMeters.x - nearest.pose.localPositionMeters.x;
      const starwardY = pose.localPositionMeters.y - nearest.pose.localPositionMeters.y;
      const starwardZ = pose.localPositionMeters.z - nearest.pose.localPositionMeters.z;
      const starwardLength = Math.hypot(starwardX, starwardY, starwardZ);
      const solarElevation = starwardLength > 0
        ? (
          nearestRadial.x * starwardX +
          nearestRadial.y * starwardY +
          nearestRadial.z * starwardZ
        ) / (observerRadialLength * starwardLength)
        : 1;
      const horizonScattering = 1 - THREE.MathUtils.smoothstep(
        Math.max(0, solarElevation),
        0.04,
        0.42,
      );
      const atmosphericOpticalDepth = surfaceAtmosphereFactor * (
        0.78 + horizonScattering * 0.58 + (observedWeather?.localMoisture ?? 0) * 0.08
      );
      setAtmosphericScattering(atmosphericOpticalDepth);
    }
    this.camera.updateMatrixWorld();
    this.planetWorkProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.planetWorkFrustum.setFromProjectionMatrix(this.planetWorkProjection,
      this.camera.coordinateSystem, this.camera.reversedDepth);
    for (const pose of [...snapshot.planets, ...snapshot.moons]) {
      const body = this.bodies.get(pose.id);
      if (!body) continue;
      this.updateBodyPosition(body.group, pose);
      body.oceanDepth.update(this.camera.position);
      const activeReceiver = Boolean(nearSurface && nearest?.pose.id === pose.id);
      let bodyLighting: CelestialLightFrame;
      let bodyLightingChanged = true;
      if (activeReceiver) {
        // Dropping a center sample prevents the receiver's local horizon from
        // being incorrectly retained when the ship leaves this atmosphere.
        this.bodyCenterLightingCache.delete(pose.id);
        bodyLighting = celestialLighting;
      } else {
        const cached = this.bodyCenterLightingCache.get(pose.id);
        const cacheAge = cached ? this.renderLocalEffectsSeconds - cached.localTimeSeconds : Number.POSITIVE_INFINITY;
        if (cached && cached.frame.systemId === snapshot.system.id && cacheAge >= 0 && cacheAge < 0.125) {
          bodyLighting = cached.frame;
          bodyLightingChanged = false;
        } else {
          bodyLighting = evaluateCelestialLighting(snapshot, {
            positionMeters: pose.localPositionMeters,
            body: body.body,
            bodyPose: pose,
            atmosphereDensity: 0,
            includeEclipses: false,
          });
          this.bodyCenterLightingCache.set(pose.id, {
            frame: bodyLighting,
            localTimeSeconds: this.renderLocalEffectsSeconds,
          });
        }
      }
      body.weatherNodes.update(this.renderLocalEffectsSeconds, bodyLighting, pose.rotationRadians);
      this.surface.contacts.updateBodyPresentation(pose.id, {
        elapsedSeconds: this.renderLocalEffectsSeconds,
        daylight: bodyLighting.daylight,
        windSpeedMetersPerSecond: body.effects.weather.windSpeedMetersPerSecond,
        celestialFrame: bodyLighting,
        bodyRotationRadians: pose.rotationRadians,
      });
      const primaryStar = snapshot.stars[0];
      let bodyFixedPrimary: THREE.Vector3 | undefined;
      let bodyFixedSecondary: THREE.Vector3 | undefined;
      if (primaryStar) {
        const primaryDirection = new THREE.Vector3(
          primaryStar.localPositionMeters.x - pose.localPositionMeters.x,
          primaryStar.localPositionMeters.y - pose.localPositionMeters.y,
          primaryStar.localPositionMeters.z - pose.localPositionMeters.z,
        ).normalize();
        const secondStar = snapshot.stars[1];
        const secondaryDirection = secondStar
          ? new THREE.Vector3(
            secondStar.localPositionMeters.x - pose.localPositionMeters.x,
            secondStar.localPositionMeters.y - pose.localPositionMeters.y,
            secondStar.localPositionMeters.z - pose.localPositionMeters.z,
          ).normalize()
          : undefined;
        if (bodyLightingChanged) body.effects.setCelestialLighting(bodyLighting);
        bodyFixedPrimary = primaryDirection.clone().applyAxisAngle(
          new THREE.Vector3(0, 1, 0),
          -pose.rotationRadians,
        );
        bodyFixedSecondary = secondaryDirection?.clone().applyAxisAngle(
          new THREE.Vector3(0, 1, 0),
          -pose.rotationRadians,
        );
      }
      body.effects.update(this.renderLocalEffectsSeconds);
      const cameraBodyDistance = body.group.position.length();
      body.visibility.update(
        this.camera,
        cameraBodyDistance,
        window.innerHeight,
        this.flight.state.targetId === body.body.id,
      );
      const bodyRadius = body.body.radiusMeters / METERS_PER_RENDER_UNIT;
      this.planetWorkBounds.set(body.group.position, bodyRadius *
        (1 + body.field.maxHeightMeters / body.field.radius));
      body.proxyLod.update({
        apparentDiameterPixels: Number(body.visibility.object.userData.apparentDiameterPixels ?? 0),
        selected: this.flight.state.targetId === body.body.id,
        distanceRatio: cameraBodyDistance / bodyRadius,
        onScreen: this.planetWorkFrustum.intersectsSphere(this.planetWorkBounds),
        deltaSeconds: delta,
      });
      const physicalRelative = new THREE.Vector3(
        this.renderObserverPosition.x - pose.localPositionMeters.x,
        this.renderObserverPosition.y - pose.localPositionMeters.y,
        this.renderObserverPosition.z - pose.localPositionMeters.z,
      );
      const bodyFixedPositionMeters = physicalRelative.clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), -pose.rotationRadians);
      const bodyFixedDirection = bodyFixedPositionMeters.clone().normalize();
      const radialAltitudeMeters = physicalRelative.length() - body.body.radiusMeters;
      const nearActualGround = body.body.isLandable &&
        radialAltitudeMeters < Math.max(400_000, body.body.atmosphere.heightMeters * 1.4) + body.field.maxHeightMeters;
      const surfaceAltitude = Math.max(0, nearActualGround
        ? surfaceDetailClearanceMeters(body.field, bodyFixedPositionMeters)
        : radialAltitudeMeters);
      const surfaceVelocityMeters = new THREE.Vector3().copy(this.renderObserverVelocity)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), -pose.rotationRadians);
      body.surfaceGroundClearanceMeters = surfaceAltitude;
      const atmosphericPresentation = THREE.MathUtils.smoothstep(
        1.13 - cameraBodyDistance / bodyRadius,
        0,
        0.105,
      );
      body.effects.setPresentation(atmosphericPresentation);
      if (
        body.body.isLandable &&
        !body.streamer &&
        nearest?.visual.body.id === body.body.id &&
        cameraBodyDistance < bodyRadius * 3.15
      ) {
        this.activateBodyTerrain(body, bodyFixedDirection);
      }
      // Geometry is queued before it is needed. Published old surfaces and
      // the full seeded globe remain in place while the shared worker runs.
      if (body.surfaceLayout) {
        this.updateSurfaceDetail(body, bodyFixedPositionMeters, surfaceVelocityMeters, surfaceAltitude);
      }
      const withinTerrainPrewarmRadius = body.streamer !== undefined &&
        cameraBodyDistance < bodyRadius * body.streamer.prewarmDistanceRatio;
      if (body.streamer && withinTerrainPrewarmRadius) {
        const relative = bodyFixedDirection.clone().multiplyScalar(cameraBodyDistance);
        const bodyFixedLookDirection = this.camera.getWorldDirection(new THREE.Vector3())
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), -pose.rotationRadians)
          .normalize();
        const bodyFixedVelocity = surfaceVelocityMeters.clone()
          .multiplyScalar(1 / METERS_PER_RENDER_UNIT);
        // This update can flush any ready job in the shared scheduler. In
        // particular, the no-Worker fallback can finish a queued visual patch
        // synchronously. Publish before deriving this frame's depth ownership.
        body.streamer.update(relative, {
          deltaSeconds: delta,
          velocity: bodyFixedVelocity,
          lookDirection: bodyFixedLookDirection,
          viewportAspect: this.camera.aspect,
          viewportHeight: window.innerHeight,
          fieldOfViewDegrees: this.camera.fov,
          prewarm: cameraBodyDistance > bodyRadius * 1.42,
        });
      }
      const presentedLayers = body.surfaceLayout
        ? surfaceDetailPresentation(body.surfaceLayout, surfaceAltitude) : [];
      const layers = body.surfacePatch ? [body.surfacePatch, ...(body.surfaceDetails ?? [])] : [];
      for (const [index, patch] of layers.entries()) {
        patch.advancePresentation(presentedLayers[index] ?? 0, delta);
        patch.visible = patch.hasGeometry && patch.presentationAlpha > 0.004;
        if (bodyFixedPrimary && (patch.visible || (index === 0 && activeReceiver))) {
          // A newly published layer receives this frame's actual stars and
          // weather before its first visible draw, including worker fallback.
          patch.setLighting(bodyFixedPrimary, bodyFixedSecondary, this.renderLocalEffectsSeconds,
            this.currentSystem.stars[0]?.color, this.currentSystem.stars[1]?.color);
          patch.setCelestialLighting(bodyLighting, pose.rotationRadians, body.body.ring);
          patch.setWind(body.effects.weather.windSpeedMetersPerSecond, bodyFixedPrimary);
        }
      }
      const terrainTransition = Math.max(0,
        ...layers.map((patch) => 4 * patch.presentationAlpha * (1 - patch.presentationAlpha)));
      body.effects.setTerrainTransition(terrainTransition);
      if (nearest?.visual.body.id === body.body.id) this.currentTerrainTransition = terrainTransition;
      const insideSurfaceDetail = Boolean(body.surfacePatch?.visible);
      body.effects.ocean.visible = body.effects.ocean.userData.physicalWaterSupported === true;
      if (body.surfacePatch) {
        const decorationsVisible = insideSurfaceDetail && surfaceAltitude < 32_000;
        if (body.surfacePatch.userData.appliedDecorationVisibility !== decorationsVisible ||
            body.surfacePatch.userData.appliedDecorationGeneration !== body.surfacePatch.generationSerial) {
          body.surfacePatch.traverse((child) => {
            if (child instanceof THREE.InstancedMesh) child.visible = decorationsVisible;
          });
          body.surfacePatch.userData.appliedDecorationVisibility = decorationsVisible;
          body.surfacePatch.userData.appliedDecorationGeneration = body.surfacePatch.generationSerial;
        }
      }
      const completeLayer = layers.find((patch) => patch.opaqueCoverages.length > 0);
      const opaqueLocalCoverage = layers.flatMap((patch): SurfacePatchCoverage[] => [...patch.opaqueCoverages]);
      body.surfaceCoverageMask.set(opaqueLocalCoverage, {
        originBodyFixedMeters: vec3(), metersPerLocalUnit: METERS_PER_RENDER_UNIT,
      });
      body.effects.setSurfaceCoverage(opaqueLocalCoverage);
      if (completeLayer) {
        body.continuityCutoutDirection.copy(completeLayer.centerDirection);
        body.continuityCutoutCosine.value = Math.cos(Math.atan(
          completeLayer.patchSize * 0.38 / bodyRadius,
        ));
      } else {
        body.continuityCutoutCosine.value = 2;
      }
      body.effects.setSurfaceCutout(
        body.continuityCutoutDirection,
        body.continuityCutoutCosine.value,
      );
      if (layers.length > 0) {
        // The mask is the exact published child square. Moving a fine patch
        // updates uniforms only; it cannot rebuild every coarser landscape.
        for (let index = 0; index < layers.length; index += 1) {
          const parent = layers[index]!;
          // Async uploads can finish out of order. The nearest actually
          // opaque finer layer owns its footprint even if an intermediate
          // level is still loading; no coarse face may bury that fine ground.
          const child = layers.slice(index + 1).find((candidate) => candidate.opaqueCoverages.length > 0);
          // A recentering parent still yields to stable finer ground, but a
          // fading child cannot remove the real coarser fallback beneath it.
          parent.setInnerCutout(child);
        }
      }
      if (body.streamer) {
        // A full six-root replacement owns only a complementary fraction of
        // the globe, then keeps the real orbital ground outside every opaque
        // local square. No small near patch can hide a whole planetary layer.
        const desiredOrbitalAlpha = withinTerrainPrewarmRadius
          ? 1 - THREE.MathUtils.smoothstep(cameraBodyDistance / bodyRadius, 1.72, 2.6)
          : 0;
        const presentation = body.streamer.present(desiredOrbitalAlpha, delta, opaqueLocalCoverage);
        body.orbitalTerrainAlpha.value = presentation.alpha;
        if (this.host.capabilities.quality !== 'fallback' && this.gpuTerrain.enabled &&
            (presentation.alpha > 0 || desiredOrbitalAlpha > 0)) {
          // These are coverage owners that can actually contribute a draw,
          // not every resident/prewarmed tile in the cache.
          for (const tile of body.streamer.getRenderableTiles(true)) {
            this.gpuTerrain.prepare(tile, tile.position);
          }
        }
      } else {
        body.orbitalTerrainAlpha.value = 0;
      }
      body.proxy.visible = body.orbitalTerrainAlpha.value < 1;
    }

    // A resolved remote planet shows the same clouds that cast its shadows.
    // Keep only one additional orbital cloud layer; tiny real destinations and
    // lower-tier surface flight must not spend their draw budget on hidden fog.
    const cloudPixelThreshold = this.host.capabilities.quality === 'fallback' ? 64 : 48;
    const allowAdditionalClouds = !nearSurface || this.host.capabilities.quality === 'high';
    const cloudCandidates = [];
    for (const body of this.bodies.values()) {
      if (body.streamer || !body.weatherField.supported) continue;
      cloudCandidates.push({ bodyId: body.body.id,
        diameterPixels: Number(body.visibility.object.userData.apparentDiameterPixels ?? 0) });
    }
    const cloudSelection = advanceOrbitalCloudSelection({
      bodyId: this.additionalOrbitalCloudBodyId,
      opacity: this.additionalOrbitalCloudOpacity,
    }, cloudCandidates, {
      allowed: allowAdditionalClouds,
      minimumDiameterPixels: cloudPixelThreshold,
      deltaSeconds: delta,
    });
    this.additionalOrbitalCloudBodyId = cloudSelection.bodyId;
    this.additionalOrbitalCloudOpacity = cloudSelection.opacity;
    for (const body of this.bodies.values()) {
      body.effects.setOrbitalCloudVisibility(body.streamer ? 1 :
        body.body.id === cloudSelection.bodyId ? cloudSelection.opacity : 0);
    }

    const surfaceState = this.surface.lifecycle.snapshot;
    const occupancy = this.surface.session.snapshot;
    const actorView = this.activeObserver?.owner === 'surface-actor';
    const mode = this.flight.state.mode === 'hyperdrive' ? 'hyper' : this.flight.state.mode;
    this.speedField.update(effectsDelta, actorView ? 0 : this.flight.state.throttle, mode,
      actorView ? 0 : this.flight.state.speedMetersPerSecond, {
      landed: this.flight.state.landed || actorView,
      atmosphereDensity: this.currentAtmosphereFactor,
    });
    this.speedField.group.visible = !actorView;
    if (this.activeObserver && this.renderShipPose) {
      const rail = this.surfaceKit?.manifest.egressRailMeters;
      const exteriorFraction = rail && rail.length > 1
        ? Math.max(1, rail.findIndex((point) => point.stage === 'exterior')) / (rail.length - 1) : 0;
      const insideHandoff = occupancy.transition && occupancy.transition.railFraction < exteriorFraction;
      this.worldShip.update({
        shipAddress: this.renderShipPose.address,
        observer: this.activeObserver,
        forward: this.renderShipPose.forward,
        up: this.renderShipPose.up,
        rollRadians: this.renderShipPose.rollRadians,
        elapsedSeconds: this.renderLocalEffectsSeconds,
        deltaSeconds: effectsDelta,
        throttle: this.flight.state.throttle,
        mode,
        speedMetersPerSecond: this.flight.state.speedMetersPerSecond,
        surfacePhase: this.flight.state.surfacePhase,
        gearProgress: surfaceState.gearProgress,
        rampProgress: this.surface.rampProgress,
        ...(insideHandoff ? { visible: false } : {}),
      });
      const surfaceBody = surfaceState.bodyId
        ? this.catalog.getBodyPose(surfaceState.bodyId, this.renderEpochSeconds) : undefined;
      const interpolatedLocal = this.renderShipPose.bodyFixed;
      this.surfaceFx.update({
        ...surfaceState,
        ...(interpolatedLocal && interpolatedLocal.bodyId === surfaceState.bodyId ? {
          bodyFixedOriginMeters: interpolatedLocal.positionMeters,
          bodyFixedForward: interpolatedLocal.forward,
          bodyFixedUp: interpolatedLocal.up,
        } : {}),
        ...(surfaceBody ? { bodyFrame: {
          id: surfaceBody.id, origin: surfaceBody.position, rotationRadians: surfaceBody.rotationRadians,
        } } : {}),
        observer: this.activeObserver,
        liftThrusterSocketsMeters: this.surfaceKit?.manifest.liftThrusterSocketsMeters ?? [],
        surfaceGravityMetersPerSecondSquared: surfaceState.bodyId
          ? this.catalog.getPlanet(surfaceState.bodyId)?.surfaceGravity ?? 0 : 0,
        elapsedSeconds: this.renderLocalEffectsSeconds,
        deltaSeconds: effectsDelta,
        shipRollRadians: this.renderShipPose.rollRadians,
      });
    }
        const inputState = this.inputRouter.snapshot;
    this.surfaceOverlay?.update({
      surfacePhase: surfaceState.surfacePhase,
      occupancyPhase: occupancy.phase,
      phaseProgress: surfaceState.phaseProgress,
      occupancyProgress: occupancy.phaseProgress,
      transitionFadeOpacity: occupancy.transition?.fadeOpacity,
      clearanceMeters: surfaceState.clearanceMeters,
      gearProgress: surfaceState.gearProgress,
      canInteract: occupancy.phase === 'outside' ? occupancy.canBoard : this.surface.lifecycle.isParkedAndSettled(),
      interactionReason: occupancy.blockingReason?.replaceAll('-', ' ').toUpperCase(),
      movementReason: this.surface.session.onFoot.snapshot.blockingReason,
      distanceToShipMeters: occupancy.boardingDistanceMeters,
      pointerLocked: inputState.pointerLocked,
      pointerLockSupported: inputState.pointerLockSupported,
      pointerLockDenied: inputState.pointerLockDenied,
      lookMode: inputState.lookMode,
      visible: this.gameplayEntered && !this.pauseMenu?.isOpen && !this.hud.isMapOpen?.(),
    });
    this.frame += 1;
    if (delta > 0) this.fps = THREE.MathUtils.lerp(this.fps, 1 / delta, 0.04);
    if (this.viewMode === 'cockpit' && this.cockpitOverlay.active) {
      this.updateCockpitRadar(snapshot, true);
    }
    if (this.frame % 3 === 0) {
      this.updateHud(this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds).poses);
      this.updateWorldTargetMarkers(snapshot.poses);
    }
    if (
      this.hud.isMapOpen?.() &&
      this.localEffectsSeconds - this.lastMapRefreshLocalSeconds >= LIVE_MAP_REFRESH_INTERVAL_SECONDS
    ) {
      this.updateMap();
    }
    this.shipOverlay.setCelestialFrame(celestialLighting);
    this.worldShip.setCelestialFrame(celestialLighting);
    this.post.setCelestialFrame(celestialLighting, delta, this.projectCelestialSources(celestialLighting));
    this.gpuTerrain.flush(2);
    this.post.render(this.scene, this.camera, () => this.shipOverlay.render(this.host.renderer), this.backgroundScene);
    const activeFrame = simulationRunning && document.visibilityState !== 'hidden';
    if (activeFrame && this.previousFrameWasActive) {
      this.frameTiming.record(performance.now() - frameCpuStarted, rawDelta * 1_000);
    }
    this.previousFrameWasActive = activeFrame;
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private updateBodyPosition(object: THREE.Object3D | undefined, pose: BodyPose) {
    if (!object) return;
    const relative = this.activeObserver
      ? subtractAddresses(pose.position, this.activeObserver.address)
      : subtractAddresses(pose.position, this.flight.state.address);
    object.position.set(
      relative.x / METERS_PER_RENDER_UNIT,
      relative.y / METERS_PER_RENDER_UNIT,
      relative.z / METERS_PER_RENDER_UNIT,
    );
    object.rotation.y = pose.rotationRadians;
  }

  private updateSurfaceDetail(
    body: BodyVisual,
    bodyFixedPositionMeters: THREE.Vector3,
    velocityMetersPerSecond: THREE.Vector3,
    clearanceMeters: number,
  ): void {
    if (!body.surfacePatch || !body.surfaceLayout) return;
    const direction = bodyFixedPositionMeters.clone().normalize();
    const closingSpeed = Math.max(0, -velocityMetersPerSecond.dot(direction));
    const tangentVelocity = velocityMetersPerSecond.clone()
      .addScaledVector(direction, -velocityMetersPerSecond.dot(direction));
    const patches = [body.surfacePatch, ...(body.surfaceDetails ?? [])];
    for (const [index, patch] of patches.entries()) {
      const layer = body.surfaceLayout[index]!;
      if (clearanceMeters > surfaceDetailPrewarmClearance(layer, closingSpeed)) continue;
      const displacement = patch.centerDirection.distanceTo(direction) * body.body.radiusMeters;
      if (patch.hasGeometry && displacement < surfaceDetailRecenterDistance(layer, clearanceMeters)) continue;
      const lead = tangentVelocity.clone().multiplyScalar(.85);
      const maximumLead = Math.min(layer.widthMeters * .16, layer.name === 'regional' ? 3_000 : 20_000);
      if (lead.length() > maximumLead) lead.setLength(maximumLead);
      const desired = direction.clone().addScaledVector(lead, 1 / body.body.radiusMeters).normalize();
      // The initial actual approach remains exact. Subsequent centers land on
      // stable body-fixed cells, not a new arbitrary point every render frame.
      const center = patch.hasGeometry ? snapSurfaceDetailDirection(desired, body.body.radiusMeters,
        Math.min(500, Math.max(layer.widthMeters / layer.segments * 2, layer.widthMeters / 32))) : desired;
      const priority = 10_000_000 + (patch.hasGeometry ? 0 : 1_000_000) +
        (index === 0 ? 500_000 : index * 1_000) - Math.min(100_000, clearanceMeters);
      patch.requestRecenter(center, priority);
    }
    this.terrainJobs.pump();
  }

  private configurePatchDepth(patch: SurfacePatch, depth: number) {
    // Three's logarithmic-depth node graph explicitly writes fragment depth,
    // which bypasses fixed-function polygon offsets on both graphics backends.
    patch.setDepthPriority(depth);
  }

  /** The old coarse ground/props relinquish only genuinely committed close coverage. */
  private refreshContactMasks(): void {
    if (!this.contactAuthority) return;
    for (const body of this.bodies.values()) {
      const generations = this.contactAuthority.getActiveGenerations(body.body.id);
      body.surfacePatch?.setContactExclusions(generations);
      for (const patch of body.surfaceDetails ?? []) patch.setContactExclusions(generations);
    }
  }

  private disposeObjectResources(...objects: THREE.Object3D[]) {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const root of objects) {
      root.traverse((item) => {
        if (!(item instanceof THREE.Mesh || item instanceof THREE.LineSegments || item instanceof THREE.Points)) return;
        geometries.add(item.geometry);
        const entries = Array.isArray(item.material) ? item.material : [item.material];
        for (const material of entries) materials.add(material);
      });
    }
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  private disposeBodyRenderResources(body: BodyVisual): void {
    // Some valid effects are intentionally detached: dry worlds have no
    // ocean draw, unsupported weather has no cloud draw, and non-landable
    // worlds have no interior sky. Include all of them in one deduplicated
    // disposal pass because wet oceans share their proxy's geometry.
    this.disposeObjectResources(body.group, body.effects.ocean,
      body.effects.atmosphere, body.effects.skyGlow, body.effects.clouds,
      ...(body.effects.rings ? [body.effects.rings] : []));
  }

  private nearestLandableBody(poses: Map<string, BodyPose>, position: Readonly<Vec3> = this.flight.state.position) {
    let nearest: { visual: BodyVisual; pose: BodyPose; altitudeMeters: number } | undefined;
    for (const visual of this.bodies.values()) {
      if (!visual.body.isLandable) continue;
      const pose = poses.get(visual.body.id);
      if (!pose) continue;
      const altitudeMeters = distanceVec3(pose.localPositionMeters, position) - visual.body.radiusMeters;
      if (!nearest || altitudeMeters < nearest.altitudeMeters) nearest = { visual, pose, altitudeMeters };
    }
    return nearest;
  }

  /** Ensure the real body's presentation exists before a contact lease is made. */
  private prepareSurfaceContact(bodyId?: string): void {
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds);
    const requestedId = bodyId ?? this.flight.state.parkedAnchor?.bodyId ?? this.flight.state.landedBodyId;
    const requested = requestedId ? this.bodies.get(requestedId) : undefined;
    const requestedPose = requestedId ? snapshot.poses.get(requestedId) : undefined;
    const nearest = requested?.body.isLandable && requestedPose
      ? { visual: requested, pose: requestedPose, altitudeMeters: 0 }
      : this.nearestLandableBody(snapshot.poses);
    if (!nearest) return;
    const bodyFixedPosition = worldToBodyFixed({
      id: nearest.pose.id,
      origin: nearest.pose.position,
      rotationRadians: nearest.pose.rotationRadians,
    }, this.flight.state.address);
    const contact = this.contactAuthority.sample(nearest.pose.id, bodyFixedPosition, {
      requireReady: false,
      includeSolids: false,
    });
    // High mountains can sit kilometres above the reference radius. Surface
    // preparation uses the same signed-ground/mean-sea clearance as landing.
    if (!contact || landingAdmissionClearanceMeters(
      bodyFixedPosition, nearest.visual.body.radiusMeters, contact,
    ) > 5_000) return;
    const direction = new THREE.Vector3().copy(bodyFixedPosition).normalize();
    if (!nearest.visual.surfacePatch) this.activateBodyTerrain(nearest.visual, direction);
    // Landing may still be rejected. Only an actual pending lease may promote
    // flow preparation above ordinary terrain or pin its immutable region.
  }

  private resolveContactFlowRegion(lease: ContactLease): ContactFlowRegionReadiness {
    const pinned = this.contactAuthority.getFlowRegion(lease.bodyId);
    if (pinned) return { status: 'ready', region: pinned };
    const body = this.bodies.get(lease.bodyId);
    if (!body?.body.isLandable) return { status: 'failed', reason: 'Contact body is unavailable.' };
    if (!body.surfacePatch) this.activateBodyTerrain(body, lease.centerDirection);
    return body.surfacePatch?.resolveContactFlowRegion(lease.centerDirection) ?? { status: 'pending' };
  }

  requestLanding(): SurfaceCommandResult {
    if (this.persistence.pendingSurfaceCheckpoint) return this.reportSurfaceCommand({ accepted: false, reason: 'restoring-surface-contact' });
    this.prepareSurfaceContact();
    return this.reportSurfaceCommand(this.surface.requestLanding());
  }

  requestTakeoff(): SurfaceCommandResult {
    if (this.persistence.pendingSurfaceCheckpoint) return this.reportSurfaceCommand({ accepted: false, reason: 'restoring-surface-contact' });
    return this.reportSurfaceCommand(this.surface.requestTakeoff());
  }

  requestSurfaceTravel(intent: SurfaceTravelIntent): SurfaceCommandResult {
    if (this.persistence.pendingSurfaceCheckpoint) return this.reportSurfaceCommand({ accepted: false, reason: 'restoring-surface-contact' });
    return this.reportSurfaceCommand(this.surface.requestTravel(intent));
  }

  requestExit(): SurfaceCommandResult {
    if (this.persistence.pendingSurfaceCheckpoint) return this.reportSurfaceCommand({ accepted: false, reason: 'restoring-surface-contact' });
    return this.reportSurfaceCommand(this.surface.requestExit());
  }

  requestBoard(): SurfaceCommandResult {
    if (this.persistence.pendingSurfaceCheckpoint) return this.reportSurfaceCommand({ accepted: false, reason: 'restoring-surface-contact' });
    return this.reportSurfaceCommand(this.surface.requestBoard());
  }

  private interactSurface(): SurfaceCommandResult {
    if (this.persistence.pendingSurfaceCheckpoint) return this.reportSurfaceCommand({ accepted: false, reason: 'restoring-surface-contact' });
    if (this.surface.session.phase !== 'inside' && this.surface.session.phase !== 'outside') {
      return this.reportSurfaceCommand(this.surface.cancel());
    }
    return this.reportSurfaceCommand(this.surface.interact());
  }

  private reportSurfaceCommand(result: SurfaceCommandResult): SurfaceCommandResult {
    const labels: Readonly<Record<string, string>> = {
      'landing-armed': 'LANDING SYSTEMS · ASSESSING CONTACT',
      'already-parked': 'AURORA SECURED',
      'takeoff-spool': 'LIFTOFF · LIFT SYSTEMS ONLINE',
      'takeoff-active': 'LIFTOFF IN PROGRESS',
      'travel-queued': 'DEPARTURE QUEUED · CLEARING THE SURFACE',
      'travel-engaged': 'AUTOMATIC INTERCEPT ENGAGED',
      'travel-cancelled': 'AUTOMATIC DEPARTURE CANCELLED',
      'exit-prewarm': 'EGRESS · PREPARING SURFACE CONTACT',
      boarding: 'BOARDING AURORA',
      'board-aurora-to-depart': 'BOARD AURORA TO DEPART',
      'surface-kit-unavailable': 'LANDING SYSTEMS UNAVAILABLE',
      'park-and-settle-before-exit': 'PARK AND SETTLE BEFORE EXITING',
      'terrain-loading': 'SURFACE CONTACT IS STILL LOADING',
      'too-high': 'DESCEND BELOW 320 M TO LAND',
      'horizontal-speed': 'SLOW DOWN BEFORE LANDING',
      'vertical-speed': 'REDUCE VERTICAL SPEED BEFORE LANDING',
      water: 'SAFE DRY SURFACE REQUIRED FOR LANDING',
      hazard: 'SAFE DRY SURFACE REQUIRED · HAZARD DETECTED',
      slope: 'LANDING SITE IS TOO STEEP',
      solid: 'LANDING FOOTPRINT IS OBSTRUCTED',
      'solid-obstacle': 'LANDING FOOTPRINT IS OBSTRUCTED',
      'drive-active': 'DISENGAGE AUTOMATED TRAVEL BEFORE LANDING',
      'restoring-surface-contact': 'RESTORING SAFE SURFACE CONTACT',
      'no-surface-transition': '',
    };
    const label = labels[result.reason] ?? result.reason.replaceAll('-', ' ').toUpperCase();
    if (label) this.hud.notify(label);
    this.syncInputOwner();
    return result;
  }

  /** Serializable evidence from the actual controllers, renderer and collider. */
  getSurfaceState() {
    const observer = this.activeObserver;
    return {
      lifecycle: this.surface.lifecycle.snapshot,
      occupancy: this.surface.session.snapshot,
      parkedAnchor: this.surface.lifecycle.parkedAnchor,
      contact: this.surface.contacts.stats,
      contactLeases: this.contactAuthority.statuses,
      terrainJobs: this.terrainJobs.stats,
      physics: this.surface.motion.diagnostics,
      fx: this.surfaceFx.diagnostics,
      input: this.inputRouter.snapshot,
      steering: this.flight.manualSteeringDiagnostics,
      kitLoaded: Boolean(this.surfaceKit),
      kitError: this.surfaceKitError,
      camera: this.flightCamera.diagnostics,
      renderEpochSeconds: this.renderEpochSeconds,
      renderLocalEffectsSeconds: this.renderLocalEffectsSeconds,
      observer: observer ? { ...observer, address: serializeAddress(observer.address) } : undefined,
      shipRenderAddress: this.renderShipPose ? serializeAddress(this.renderShipPose.address) : undefined,
    };
  }

  /** On-demand bounded timings; CPU submission is not a GPU duration measurement. */
  getPerformanceState() {
    return {
      frames: this.frameTiming.snapshot,
      terrainJobs: this.terrainJobs.stats,
      gpuTerrain: this.gpuTerrain.stats,
      renderer: this.host.getMetrics(),
      planets: [...this.bodies.values()].map((body) => {
        const patches = body.surfacePatch ? [body.surfacePatch, ...(body.surfaceDetails ?? [])] : [];
        return {
          id: body.body.id,
          name: body.body.name,
          apparentDiameterPixels: Number(body.visibility.object.userData.apparentDiameterPixels ?? 0),
          proxy: body.proxyLod.stats,
          orbital: body.streamer?.stats ?? null,
          opaqueLocalCoverages: body.surfaceCoverageMask.count,
          surfaceReplacementTransitions: patches.filter((patch) => patch.replacementTransitioning).length,
          surfaceReplacementBytes: patches.reduce((total, patch) => total + Number(patch.userData.retiringGroundBytes ?? 0), 0),
          surfaceReplacementTriangles: patches.reduce((total, patch) => total + Number(patch.userData.retiringGroundTriangles ?? 0), 0),
        };
      }),
    };
  }

  private updateStellarLighting(frame: CelestialLightFrame) {
    const lights = [this.sunlight, this.secondarySunlight, this.tertiarySunlight];
    for (let index = 0; index < lights.length; index++) {
      const light = lights[index]!;
      const source = frame.sources[index];
      if (!source?.active || source.irradianceSolar <= 0.00001 || source.eclipseVisibility <= 0.0001) {
        light.intensity = 0;
        continue;
      }
      light.position.set(
        source.directionWorld.x,
        source.directionWorld.y,
        source.directionWorld.z,
      ).normalize().multiplyScalar(12);
      light.color.set(source.colorHex ?? '#ffffff');
      if (source.horizonVisibility > 0.0001) {
        light.color.r *= source.atmosphericTransmittance.r;
        light.color.g *= source.atmosphericTransmittance.g;
        light.color.b *= source.atmosphericTransmittance.b;
      }
      light.intensity = THREE.MathUtils.clamp(
        Math.sqrt(source.irradianceSolar * source.eclipseVisibility) * (index === 0 ? 1.02 : 0.88),
        0,
        2.25,
      );
    }
  }

  /** Optical artifacts are anchored only to genuine, currently visible suns. */
  private projectCelestialSources(frame: CelestialLightFrame) {
    const viewport = { width: window.innerWidth, height: window.innerHeight, padding: 0 };
    const projected = [];

    for (const source of frame.sources) {
      if (!source.active || !source.id) continue;
      const star = this.stars.get(source.id);
      if (!star) continue;
      const position = projectNavigationTarget(this.camera, star.position, viewport);
      if (!position) continue;

      const descriptor = this.currentSystem.stars[source.slot];
      const angularRadius = descriptor
        ? apparentRadiusPixels(
          this.camera,
          descriptor.radiusMeters / METERS_PER_RENDER_UNIT,
          star.position.length(),
          viewport.height,
        ) / Math.max(1, viewport.height)
        : 0;
      projected.push({
        id: source.id,
        u: position.x / Math.max(1, viewport.width),
        // RenderPipeline's fullscreen QuadMesh uses top-origin UV on both
        // supported backends; TextureNode applies backend texture flips itself.
        v: position.y / Math.max(1, viewport.height),
        visible: position.visible && source.visibility > 0.0001,
        angularRadius,
        color: source.colorHex,
      });
    }

    return projected;
  }

  private updateWorldTargetMarkers(poses: Map<string, BodyPose>) {
    if (!this.hud.setWorldTargets) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight, padding: 82 };
    const activeTargetId = this.flight.state.targetId;
    const canonicalAddress = this.canonicalPlayerAddress();
    const canonicalPosition = subtractAddresses(canonicalAddress, this.currentSystem.position);
    const canonicalPoses = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds).poses;
    const canonicalNearest = this.nearestLandableBody(canonicalPoses, canonicalPosition);
    const projections: SceneWorldTarget[] = [];
    this.sceneTargets.clear();

    for (const visual of this.bodies.values()) {
      const selected = visual.body.id === activeTargetId;
      if (visual.body.parentPlanetId && !selected && visual.body.id !== this.hoveredTargetId) continue;
      const pose = poses.get(visual.body.id);
      if (!pose) continue;
      const projection = projectNavigationTarget(this.camera, visual.group.position, viewport);
      if (!projection || (!projection.visible && !selected)) continue;
      const physicalPose = canonicalPoses.get(visual.body.id) ?? pose;
      const relative = {
        x: canonicalPosition.x - physicalPose.localPositionMeters.x,
        y: canonicalPosition.y - physicalPose.localPositionMeters.y,
        z: canonicalPosition.z - physicalPose.localPositionMeters.z,
      };
      const groundHeight = canonicalNearest?.pose.id === visual.body.id
        ? Math.max(0, visual.collision?.sample(rotateAroundYAxis(relative, -physicalPose.rotationRadians)).heightMeters ?? 0)
        : 0;
      const distanceMeters = Math.max(0,
        distanceVec3(physicalPose.localPositionMeters, canonicalPosition) - visual.body.radiusMeters - groundHeight);
      const marker: SceneWorldTarget = {
        id: visual.body.id,
        kind: 'planet',
        name: visual.body.name,
        x: projection.x,
        y: projection.y,
        visible: projection.visible,
        offscreen: projection.offscreen,
        bearingRadians: projection.bearingRadians,
        distance: formatDistance(distanceMeters),
        selected,
        color: visual.body.colors.atmosphere,
        label: visual.body.parentPlanetId
          ? `${visual.body.archetype.replace('-', ' ').toUpperCase()} MOON`
          : visual.body.archetype.replace('-', ' ').toUpperCase(),
        radius: apparentRadiusPixels(
          this.camera,
          visual.body.radiusMeters / METERS_PER_RENDER_UNIT,
          projection.distanceToCamera,
          viewport.height,
        ),
        description: `${visual.body.ring ? 'RINGED · ' : ''}${visual.body.isLandable ? 'LANDABLE' : 'UPPER ATMOSPHERE'}`,
      };
      this.sceneTargets.set(marker.id, marker);
      if (projection.visible || selected) projections.push(marker);
    }

    for (const [starId, group] of this.stars) {
      const descriptor = this.catalog.getStar(starId);
      const pose = poses.get(starId);
      if (!descriptor || !pose) continue;
      const selected = starId === activeTargetId;
      const projection = projectNavigationTarget(this.camera, group.position, viewport);
      if (!projection || (!projection.visible && !selected)) continue;
      const marker: SceneWorldTarget = {
        id: starId,
        kind: 'planet',
        name: descriptor.name,
        x: projection.x,
        y: projection.y,
        visible: projection.visible,
        offscreen: projection.offscreen,
        bearingRadians: projection.bearingRadians,
        distance: formatDistance(Math.max(0, distanceVec3(
          (canonicalPoses.get(starId) ?? pose).localPositionMeters, canonicalPosition) - descriptor.radiusMeters)),
        selected,
        color: descriptor.color,
        label: `${descriptor.spectralType}${descriptor.spectralSubtype} · STELLAR BODY`,
        description: `${Math.round(descriptor.temperatureKelvin).toLocaleString()} K PHOTOSPHERE`,
      };
      this.sceneTargets.set(marker.id, marker);
      if (selected || starId === this.hoveredTargetId) projections.push(marker);
    }

    const inspectedSystemIds = new Set([activeTargetId, this.hoveredTargetId]);
    for (const systemId of inspectedSystemIds) {
      if (!systemId) continue;
      const inspectedSystem = this.catalog.getSystem(systemId);
      if (!inspectedSystem || inspectedSystem.id === this.currentSystem.id) continue;
      const pointIndex = this.starfield.systemIds.indexOf(inspectedSystem.id);
      const positions = this.starfield.points.geometry.getAttribute('position');
      if (pointIndex < 0 || !positions) continue;
      const skyPosition = new THREE.Vector3(
        positions.getX(pointIndex),
        positions.getY(pointIndex),
        positions.getZ(pointIndex),
      );
      const projection = projectNavigationTarget(this.camera, skyPosition, viewport);
      const selected = inspectedSystem.id === activeTargetId;
      if (!projection || (!projection.visible && !selected)) continue;
      const marker: SceneWorldTarget = {
        id: inspectedSystem.id,
        kind: 'system',
        name: inspectedSystem.name,
        x: projection.x,
        y: projection.y,
        visible: projection.visible,
        offscreen: projection.offscreen,
        bearingRadians: projection.bearingRadians,
        distance: formatDistance(Math.hypot(...Object.values(subtractAddresses(inspectedSystem.position, canonicalAddress)))),
        selected,
        color: inspectedSystem.stars[0]?.color,
        label: `${inspectedSystem.kind.toUpperCase()} STAR SYSTEM`,
        description: `${inspectedSystem.planets.length} WORLDS · HYPERDRIVE READY`,
      };
      this.sceneTargets.set(marker.id, marker);
      projections.push(marker);
    }

    this.hud.setWorldTargets(projections);
  }

  private updateHud(poses: Map<string, BodyPose>) {
    const outside = this.surface.session.phase === 'outside';
    const playerPosition = subtractAddresses(this.canonicalPlayerAddress(), this.currentSystem.position);
    const targetId = this.flight.state.targetId;
    const targetBody = targetId ? this.catalog.getBody(targetId) : undefined;
    const targetSystem = targetId ? this.catalog.getSystem(targetId) : undefined;
    const targetPose = targetId ? poses.get(targetId) : undefined;
    const nearest = this.nearestLandableBody(poses, playerPosition);
    const nearby = nearest?.pose;
    const nearbyBody = nearest?.visual;
    let nearbySurfaceHeight = 0;
    if (nearby) {
      const displacement = {
        x: playerPosition.x - nearby.localPositionMeters.x,
        y: playerPosition.y - nearby.localPositionMeters.y,
        z: playerPosition.z - nearby.localPositionMeters.z,
      };
      const bodyFixedDirection = rotateAroundYAxis(displacement, -nearby.rotationRadians);
      nearbySurfaceHeight = Math.max(
        0,
        nearbyBody?.collision?.sample(bodyFixedDirection).heightMeters ?? 0,
      );
    }
    const targetDistance = targetPose
      ? distanceVec3(targetPose.localPositionMeters, playerPosition)
        - (this.catalog.getBody(targetPose.id)?.radiusMeters ?? 0)
        - (targetPose.id === nearby?.id ? nearbySurfaceHeight : 0)
      : targetSystem
        ? Math.hypot(...Object.values(subtractAddresses(targetSystem.position, this.canonicalPlayerAddress())))
        : 0;
    this.altitudeMeters = nearby
      ? Math.max(
        0,
        distanceVec3(nearby.localPositionMeters, playerPosition)
          - nearbyBody!.body.radiusMeters
          - nearbySurfaceHeight,
      )
      : Math.max(targetDistance, 0);
    const heading = ((-this.flight.state.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const hudSnapshot: HudSnapshot = {
      systemName: this.currentSystem.name,
      systemKind: this.currentSystem.kind,
      targetName: targetBody?.name ?? targetSystem?.name ?? 'FREE FLIGHT',
      targetKind: targetSystem
        ? 'STAR SYSTEM'
        : this.catalog.getStar(targetId ?? '')
          ? 'STELLAR BODY'
          : this.catalog.getPlanet(targetId ?? '')?.archetype ?? 'WAYPOINT',
      distance: formatDistance(Math.max(0, targetDistance)),
      eta: formatDuration(this.flight.estimateArrivalSeconds()),
      speed: formatSpeed(outside ? this.surface.session.snapshot.walkingSpeedMetersPerSecond : this.flight.state.speedMetersPerSecond),
      mode: outside ? 'ON FOOT' : this.flight.state.landed ? 'LANDED' : this.flight.state.mode,
      altitude: this.altitudeMeters < 100_000_000 ? formatDistance(this.altitudeMeters) : 'DEEP SPACE',
      heading,
      starCount: this.catalog.count,
      fps: this.fps,
      discovered: this.discoveries.discoveredSystems.length,
      targetId,
    };
    this.hud.update(hudSnapshot);
    if (this.activeObserver?.owner === 'ship-cockpit') {
      this.cockpitOverlay.update(hudSnapshot);
    }
  }

  /** Navigation uses the real active actor, never a damped presentation camera. */
  private canonicalPlayerAddress(epoch = this.simulationSeconds): GalacticAddress {
    const actor = this.surface?.session.phase === 'outside' ? this.surface.session.actor : undefined;
    const body = actor ? this.catalog.getBodyPose(actor.bodyId, epoch) : undefined;
    return actor && body
      ? bodyFixedToWorld({ id: body.id, origin: body.position, rotationRadians: body.rotationRadians }, actor.bodyFixedCenterMeters)
      : this.flight.state.address;
  }

  private updateCockpitRadar(snapshot: SystemSnapshot, renderedFrame = false): void {
    const renderedShip = renderedFrame ? this.renderShipPose : undefined;
    this.cockpitRadar = buildCockpitRadar(snapshot, {
      shipPositionMeters: renderedShip
        ? subtractAddresses(renderedShip.address, this.currentSystem.position)
        : this.flight.state.position,
      forward: renderedShip?.forward ?? this.flight.state.forward,
      referenceUp: {
        x: this.cameraReferenceUp.x,
        y: this.cameraReferenceUp.y,
        z: this.cameraReferenceUp.z,
      },
      activeTargetId: this.flight.state.targetId,
    });
    this.cockpitOverlay.updateRadarFrame(this.cockpitRadar, {
      speedMetersPerSecond: this.flight.state.speedMetersPerSecond,
      throttle: this.flight.state.throttle,
      altitudeMeters: this.altitudeMeters,
      ...(this.cockpitRadar.selectedDistanceMeters !== undefined
        ? { targetDistanceMeters: this.cockpitRadar.selectedDistanceMeters }
        : {}),
      landed: this.flight.state.landed,
    });
    if (renderedFrame) {
      this.cockpitRadarFrameUpdates += 1;
      this.cockpitRadarLastFrame = this.frame;
    }
  }

  /** Select the genuine authored pilot viewpoint without changing physical flight. */
  setViewMode(mode: FlightViewMode): FlightViewMode {
    if (mode !== 'chase' && mode !== 'cockpit') return this.viewMode;
    if (this.surface && this.surface.session.phase !== 'inside') return this.viewMode;
    if (mode === this.viewMode) return this.viewMode;

    this.viewMode = mode;
    const cockpit = mode === 'cockpit';
    this.shipOverlay.setCockpitMode(cockpit);
    this.hud.setCockpitMode(cockpit);
    this.cockpitOverlay.setActive(cockpit);
    this.resetRenderHistory('view-switch');
    this.updateRenderObserver(0);
    if (cockpit) {
      const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds);
      this.updateCockpitRadar(snapshot);
      this.updateHud(snapshot.poses);
    } else {
      this.cockpitRadar = undefined;
    }
    this.camera.updateProjectionMatrix();
    this.syncInputOwner();
    this.hud.notify(cockpit ? 'AURORA FLIGHT DECK · COCKPIT VIEW' : 'EXTERNAL CHASE VIEW');
    return this.viewMode;
  }

  getState(): ExposedGameState {
    const renderedPoses = this.catalog.evaluateSystem(this.currentSystem, this.renderEpochSeconds).poses;
    const renderedNearest = this.nearestLandableBody(renderedPoses, this.renderObserverPosition);
    const activeBody = renderedNearest?.visual.streamer ? renderedNearest.visual
      : [...this.bodies.values()].find((body) => body.streamer);
    const renderer = this.host.getMetrics();
    const terrain = activeBody?.streamer?.stats;
    const gpuTerrain = this.gpuTerrain?.stats;
    const weather = activeBody?.effects.weather;
    const surfaceStats = activeBody?.surfacePatch?.stats;
    const visibleTerrain = activeBody?.streamer?.group.children.filter((child) => child.visible) ?? [];
    const terrainTransitionAlpha = visibleTerrain.length > 0
      ? visibleTerrain.reduce(
        (sum, child) => sum + Number(child.userData.fadeProgress ?? 1),
        0,
      ) / visibleTerrain.length
      : activeBody?.surfacePatch?.presentationAlpha ?? 0;
    const deepestVisibleSurface = [...(activeBody?.surfaceDetails ?? [])]
      .reverse()
      .find((patch) => patch.visible);
    const pose = activeBody ? renderedPoses.get(activeBody.body.id) : undefined;
    const direction = pose
      ? new THREE.Vector3(
        this.renderObserverPosition.x - pose.localPositionMeters.x,
        this.renderObserverPosition.y - pose.localPositionMeters.y,
        this.renderObserverPosition.z - pose.localPositionMeters.z,
      ).applyAxisAngle(new THREE.Vector3(0, 1, 0), -pose.rotationRadians).normalize()
      : undefined;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const guidance = this.flight.getGuidance();
    const selectedBody = this.flight.state.targetId ? this.bodies.get(this.flight.state.targetId) : undefined;
    const lightingFrame = this.celestialLightingFrame;
    const lightingSources = lightingFrame?.sources.filter((source) => source.active && source.id) ?? [];
    const dominantLightingSource = lightingFrame && lightingFrame.dominantSlot >= 0
      ? lightingFrame.sources[lightingFrame.dominantSlot]
      : undefined;
    const geographicSample = activeBody && direction
      ? samplePlanetClimate(activeBody.field, direction)
      : undefined;
    const weatherSample = activeBody && direction
      ? activeBody.weatherField.sample(direction, this.renderLocalEffectsSeconds)
      : undefined;
    const shadowSlot = Math.max(0, Math.min(2, lightingFrame?.dominantSlot ?? 0)) as 0 | 1 | 2;
    const cloudTransmission = activeBody && direction
      ? activeBody.weatherNodes.sampleTransmission(
        direction.clone().multiplyScalar(
          geographicSample?.radialMeters ?? activeBody.body.radiusMeters,
        ),
        shadowSlot,
      )
      : 1;
    const surfaceState = this.surface.lifecycle.snapshot;
    const occupancy = this.surface.session.snapshot;
    return {
      systemCount: this.catalog.count,
      systemId: this.currentSystem.id,
      systemName: this.currentSystem.name,
      celestialTimeScale: this.celestialTimeScale,
      celestialTimeSeconds: this.simulationSeconds,
      localEffectsSeconds: this.localEffectsSeconds,
      mode: this.flight.state.mode,
      landed: this.flight.state.landed,
      ...(this.flight.state.landedBodyId ? { landedBodyId: this.flight.state.landedBodyId } : {}),
      surfacePhase: surfaceState.surfacePhase,
      occupancyPhase: occupancy.phase,
      contactReady: surfaceState.contactReady,
      ...(surfaceState.contactGenerationId ? { contactGenerationId: surfaceState.contactGenerationId } : {}),
      ...(occupancy.actor ? { actorBodyId: occupancy.actor.bodyId } : {}),
      actorGrounded: occupancy.grounded,
      actorEyeHeightMeters: occupancy.eyeHeightMeters,
      surfaceKitLoaded: Boolean(this.surfaceKit),
      shipWorldSpace: this.worldShip.root.userData.worldSpaceExterior === true,
      sharedWorldDepth: this.worldShip.root.userData.sharedWorldDepth === true,
      renderEpochSeconds: this.renderEpochSeconds,
      renderLocalEffectsSeconds: this.renderLocalEffectsSeconds,
      observerOwner: this.activeObserver?.owner ?? 'ship-chase',
      targetId: this.flight.state.targetId,
      speedMetersPerSecond: this.flight.state.speedMetersPerSecond,
      altitudeMeters: this.altitudeMeters,
      fps: this.fps,
      particles: this.speedField.activeCount,
      renderer: this.host.capabilities.backend,
      rendererDeviceStatus: this.host.capabilities.deviceStatus,
      rendererDeviceLost: this.host.capabilities.deviceLost,
      ...(this.host.capabilities.deviceLossReason
        ? { rendererDeviceLossReason: this.host.capabilities.deviceLossReason }
        : {}),
      logarithmicDepth: this.host.capabilities.logarithmicDepth,
      quality: this.host.capabilities.quality,
      graphicsQuality: this.graphicsQuality,
      effectiveGraphicsQuality: this.host.capabilities.quality === 'high' ? 'high' : 'low',
      renderResolutionCap: this.host.resolutionCap,
      terrainTiles: terrain?.resident ?? 0,
      terrainQueued: terrain?.queued ?? 0,
      terrainGenerating: terrain?.generating ?? 0,
      terrainTriangles: terrain?.triangleCount ?? 0,
      terrainReady: terrain?.ready ?? false,
      terrainReadiness: terrain?.readiness ?? 0,
      terrainPrewarmed: Boolean(activeBody?.streamer && (terrain?.resident ?? 0) > 0),
      terrainPrewarming: terrain?.prewarming ?? false,
      terrainPrewarmAltitudeMeters: terrain?.altitudeMeters ?? 0,
      terrainVisibleTiles: terrain?.visible ?? 0,
      terrainFadingTiles: terrain?.fading ?? 0,
      terrainPendingUploads: terrain?.pendingUploads ?? 0,
      terrainParentRetained: terrain?.parentRetained ?? 0,
      terrainLodTransitions: terrain?.transitions ?? 0,
      terrainPredictedLeadMeters: terrain?.predictedLeadMeters ?? 0,
      terrainCoverageSamples: terrain?.coverageSamples ?? 0,
      terrainCoveredSamples: terrain?.coveredSamples ?? 0,
      terrainHorizonCoverage: terrain?.horizonCoverage ?? 0,
      terrainForwardCoverage: terrain?.forwardCoverage ?? 0,
      terrainPredictedCoverage: terrain?.predictedCoverage ?? 0,
      terrainCoverageReady: terrain?.coverageReady ?? false,
      terrainHorizonTiles: terrain?.horizonTiles ?? 0,
      terrainSixRootCoverageReady: terrain?.sixRootCoverageReady ?? false,
      terrainGlobalAlpha: activeBody?.orbitalTerrainAlpha.value ?? 0,
      terrainViewCulledTiles: terrain?.viewCulled ?? 0,
      terrainOcclusionCulledTiles: terrain?.occlusionCulled ?? 0,
      terrainTransitionAlpha,
      terrainProxyAlpha: activeBody?.proxy.visible ? 1 - activeBody.orbitalTerrainAlpha.value : 0,
      terrainChildAlpha: deepestVisibleSurface?.presentationAlpha ?? 0,
      terrainTransitionVeil: this.currentTerrainTransition,
      planetContinuityVisible: Boolean(activeBody?.proxy.visible || activeBody?.streamer?.group.visible ||
        activeBody?.surfacePatch?.visible),
      planetProxyVisible: Boolean(activeBody?.proxy.visible),
      planetProxyDetail: activeBody?.proxyLod.stats.currentDetail ?? 0,
      planetProxyPendingDetail: activeBody?.proxyLod.stats.pendingDetail ?? null,
      planetProxyTransitioning: activeBody?.proxyLod.stats.transitioning ?? false,
      planetSurfaceVisible: Boolean(activeBody?.surfacePatch?.visible),
      ...(activeBody ? { terrainBodyId: activeBody.body.id } : {}),
      terrainFieldVersion: activeBody?.field.generatorVersion ?? 0,
      geographyFeatureCount: activeBody && activeBody.field.generatorVersion >= 2
        ? createPlanetGeologyProfile(activeBody.field).features.length
        : 0,
      geographyReliefMeters: geographicSample?.macroReliefMeters ?? 0,
      ...(geographicSample?.geologyFeatureId ? { geographyFeatureId: geographicSample.geologyFeatureId } : {}),
      terrainMaxDepth: terrain?.maxDepth ?? 0,
      terrainTileSegments: activeBody ? 32 : 0,
      surfacePatchVisible: Boolean(activeBody?.surfacePatch?.visible),
      surfacePatchAngularError: direction && activeBody?.surfacePatch
        ? direction.angleTo(activeBody.surfacePatch.centerDirection)
        : 0,
      surfaceDecorations: activeBody?.surfacePatch?.stats.decorationInstances ?? 0,
      surfaceDecorationsVisible: Boolean(activeBody?.surfacePatch?.children.some((child) => (
        child instanceof THREE.InstancedMesh && child.visible
      ))),
      surfaceVegetation: activeBody?.surfacePatch?.stats.vegetation ?? 0,
      surfaceCrystals: activeBody?.surfacePatch?.stats.crystals ?? 0,
      surfaceRidges: activeBody?.surfacePatch?.stats.ridges ?? 0,
      surfaceBiomeId: surfaceStats?.biomeId ?? '',
      ...(activeBody ? { activeSurfaceArchetype: activeBody.body.archetype } : {}),
      surfaceRiverSegments: surfaceStats?.riverSegments ?? 0,
      surfaceLavaSegments: surfaceStats?.lavaSegments ?? 0,
      surfaceVolcanicVents: surfaceStats?.volcanicVents ?? 0,
      surfaceCraters: surfaceStats?.craterInstances ?? 0,
      surfaceEcologyFlora: surfaceStats?.ecologyFlora ?? 0,
      surfaceEcologyRocks: surfaceStats?.ecologyRocks ?? 0,
      surfaceEcologyDrawCalls: surfaceStats?.ecologyDrawCalls ?? 0,
      atmosphereFactor: this.currentAtmosphereFactor,
      atmosphereDensity: weather?.atmosphericDensity ?? 0,
      atmosphericDensity: weather?.atmosphericDensity ?? 0,
      cloudDensity: weather?.cloudDensity ?? 0,
      cloudInside: weather?.insideCloud ?? false,
      insideCloud: weather?.insideCloud ?? false,
      cloudBaseMeters: weather?.cloudBaseMeters ?? 0,
      cloudTopMeters: weather?.cloudTopMeters ?? 0,
      cloudClusterCount: weather?.localClusterCount ?? 0,
      weatherClusterCount: weather?.localClusterCount ?? 0,
      nearCloudClusterCount: weather?.nearClusterCount ?? 0,
      farCloudClusterCount: weather?.farClusterCount ?? 0,
      cloudCrossings: this.cloudCrossings,
      weatherHumidity: weather?.localMoisture ?? 0,
      weatherOpticalDepth: weather?.opticalDepth ?? 0,
      weatherSurfaceClearanceMeters: weather?.surfaceClearanceMeters ?? 0,
      weatherRareFormations: weather?.rareFormationCount ?? 0,
      weatherPhase: weather?.weatherPhase ?? 0,
      weatherRegime: (weatherSample?.stormIntensity ?? 0) > 0.62
        ? 'storm'
        : (weatherSample?.density ?? 0) > 0.68
          ? 'overcast'
          : (weatherSample?.density ?? 0) > 0.12 ? 'broken' : 'clear',
      stormIntensity: weatherSample?.stormIntensity ?? 0,
      cloudTransmission,
      cloudShadowStrength: 1 - cloudTransmission,
      cloudShadowSourceIds: activeBody?.weatherNodes.sourceIds.filter(
        (id): id is string => Boolean(id),
      ) ?? [],
      weatherVisibilityMeters: this.scene.fog === this.surfaceFog
        ? this.surfaceFog.far * METERS_PER_RENDER_UNIT
        : 0,
      precipitation: weather?.precipitation ?? 0,
      windSpeedMetersPerSecond: weather?.windSpeedMetersPerSecond ?? 0,
      ...(weather?.bodyId ? { cloudBodyId: weather.bodyId } : {}),
      ...(weather?.cellKey ? { cloudCellKey: weather.cellKey } : {}),
      discovered: this.discoveries.discoveredSystems.length,
      renderWidth: renderer.drawingBufferWidth,
      renderHeight: renderer.drawingBufferHeight,
      renderPixelRatio: renderer.pixelRatio,
      drawCalls: renderer.drawCalls,
      triangles: renderer.triangles,
      geometries: renderer.geometries,
      textures: renderer.textures,
      gpuComputeSupported: gpuTerrain?.enabled ?? false,
      gpuTerrainComputeActive: (gpuTerrain?.dispatches ?? 0) > 0,
      gpuTerrainComputeDispatches: gpuTerrain?.dispatches ?? 0,
      gpuTerrainCachedTiles: gpuTerrain?.resident ?? 0,
      gpuTerrainComputeVertices: gpuTerrain?.vertices ?? 0,
      gpuTerrainComputePending: gpuTerrain?.pending ?? 0,
      postLocalizedBloom: this.post.userData.localizedBloom,
      postHighlightShoulder: this.post.userData.highlightShoulder,
      postStellarHdrBloom: this.post.userData.stellarHdrBloom,
      postStellarSpectralHighlights: this.post.userData.stellarSpectralHighlights,
      celestialLightSourceIds: lightingSources.map((source) => source.id!),
      celestialLightCount: lightingFrame?.sourceCount ?? 0,
      ...(dominantLightingSource?.id ? { dominantVisibleSourceId: dominantLightingSource.id } : {}),
      directIrradiance: lightingFrame?.totalIrradianceSolar ?? 0,
      daylight: lightingFrame?.daylight ?? 0,
      twilight: lightingFrame?.twilight ?? 0,
      night: lightingFrame?.night ?? 0,
      horizonBlockedSourceIds: lightingSources
        .filter((source) => source.horizonVisibility < 0.001)
        .map((source) => source.id!),
      eclipsedSourceIds: lightingSources
        .filter((source) => source.eclipseOcclusion > 0.001)
        .map((source) => source.id!),
      lightingExposure: this.post.exposureController.value,
      lightingExposureTarget: this.post.exposureController.target,
      postAdaptiveExposure: this.post.userData.adaptiveExposure,
      postPhysicalCelestialOptics: this.post.userData.physicalCelestialOptics,
      particleBudget: this.speedField.maximumCount,
      targetDistanceMeters: guidance?.surfaceDistanceMeters ?? 0,
      targetEtaSeconds: guidance?.etaSeconds ?? Number.POSITIVE_INFINITY,
      targetAlignment: guidance?.alignment ?? 0,
      targetCaptureAltitudeMeters: guidance?.targetKind === 'body'
        ? Math.max(
          0,
          guidance.captureRadiusMeters - (
            this.catalog.getBody(guidance.targetId)?.radiusMeters
            ?? this.catalog.getStar(guidance.targetId)?.radiusMeters
            ?? 0
          ),
        )
        : 0,
      flightPhase: this.flight.state.phase,
      ...(guidance?.departurePhase ? { autopilotPhase: guidance.departurePhase } : {}),
      ...(guidance?.departureBodyId ? { autopilotDepartureBodyId: guidance.departureBodyId } : {}),
      ...(guidance?.departureClearanceMeters !== undefined
        ? { autopilotClearanceMeters: guidance.departureClearanceMeters }
        : {}),
      throttle: this.flight.state.throttle,
      pitchRadians: this.flight.state.pitch,
      yawRadians: this.flight.state.yaw,
      surfaceInfluence: this.flight.state.surfaceInfluence,
      cameraAngularDelta: this.cameraAngularDelta,
      cameraReferenceUp: {
        x: this.cameraReferenceUp.x,
        y: this.cameraReferenceUp.y,
        z: this.cameraReferenceUp.z,
      },
      viewMode: this.viewMode,
      cockpitVisible: this.activeObserver?.owner === 'ship-cockpit' && this.cockpitOverlay.active,
      cockpitEyeOffsetMeters: { ...this.cameraViewOffset },
      cockpitRadarContacts: this.cockpitRadar?.contacts.length ?? 0,
      cockpitRadarContactIds: this.cockpitRadar?.contacts.map((contact) => contact.id) ?? [],
      cockpitRadarFrameUpdates: this.cockpitRadarFrameUpdates,
      cockpitRadarLastFrame: this.cockpitRadarLastFrame,
      ...(this.cockpitRadar ? { cockpitRadarEpoch: this.cockpitRadar.timeSeconds } : {}),
      ...(this.cockpitRadar?.selectedTargetId
        ? { cockpitRadarTargetId: this.cockpitRadar.selectedTargetId }
        : {}),
      visibleDistantBodies: [...this.bodies.values()].filter((body) => body.visibility.object.visible).length,
      targetApparentDiameterPixels: Number(selectedBody?.visibility.object.userData.apparentDiameterPixels ?? 0),
      targetBeaconDiameterPixels: Number(selectedBody?.visibility.object.userData.beaconDiameterPixels ?? 0),
      shipForegroundPass: this.activeObserver?.owner === 'ship-cockpit',
      shipAssetLoaded: this.ship.group.userData.assetLoaded === true,
      shipAssetId: String(this.ship.group.userData.assetId ?? ''),
      shipAssetUrl: String(this.ship.group.userData.assetUrl ?? ''),
      shipTriangles: Number(this.ship.group.userData.triangleCount ?? 0),
      shipMaterialBatches: Number(this.ship.group.userData.materialBatchCount ?? 0),
      shipMaterialRoles: Array.isArray(this.ship.group.userData.materialRoles)
        ? [...this.ship.group.userData.materialRoles as string[]]
        : [],
      shipNodeMaterials: this.ship.group.userData.nodeMaterials === true,
      shipTransmissionPasses: Number(this.ship.group.userData.transmissionPasses ?? 0),
      postProcessing: Boolean(this.post?.active),
      postProcessingPasses: this.post?.userData.passes ?? 0,
      sceneAntialiasingSamples: this.post.userData.sceneSamples,
      sceneAntialiasing: this.post.userData.antialiasing,
      spatialAntialiasing: this.post.userData.spatialAntialiasing,
      spatialAntialiasingPasses: this.post.userData.spatialAntialiasingPasses,
      neonPhosphorMode: this.neonPhosphorMode,
      neonPhosphorEnabled: this.post.phosphorSettings.enabled,
      launchReady: this.gameplayEntered || this.launchScreen?.ready === true,
      launchEntered: this.gameplayEntered,
      launchVisible: this.launchScreen?.active === true,
      pauseMenuOpen: this.pauseMenu?.isOpen === true,
      blueFireParticleCount: Number(this.worldShip.exhaust.group.userData.blueFireParticleCount ?? 0),
      exhaustDrawCalls: this.worldShip.exhaust.group.visible
        ? Number(this.worldShip.root.userData.boundedPropulsionDrawCalls ?? 0) : 0,
      cosmicBiomeId: this.systemVisualTheme?.id ?? '',
      cosmicBiomeName: this.systemVisualTheme?.name ?? '',
      cosmicBiomeFamily: this.systemVisualTheme?.family ?? '',
      cosmicBiomeSeed: this.systemVisualTheme?.seed ?? 0,
      cosmicBiomePrimaryColor: this.systemVisualTheme?.primaryHex ?? '',
      cosmicBiomeSecondaryColor: this.systemVisualTheme?.secondaryHex ?? '',
      cosmicBiomeAccentColor: this.systemVisualTheme?.accentHex ?? '',
      cosmicBiomeDensity: this.systemVisualTheme?.density ?? 0,
      cosmicBiomeCoverage: this.systemVisualTheme?.coverage ?? 0,
      cosmicBiomeDrawCalls: Number(this.nebula?.userData.drawBatchCount ?? 0),
      cosmicBiomeOuterRadiusAu: this.systemNebulaVolume?.outerRadiusAu ?? 0,
      cosmicBiomeAnchorKind: this.systemNebulaVolume?.anchorKind ?? '',
      cosmicBiomeAtmosphericTransmittance: Number(
        this.starfield?.atmosphericTransmittance.value ?? 0,
      ),
      mapOpen: Boolean(this.hud.isMapOpen?.()),
      ...(this.hoveredTargetId ? { hoveredTargetId: this.hoveredTargetId } : {}),
      ...(heap?.usedJSHeapSize ? { usedHeapBytes: heap.usedJSHeapSize } : {}),
    };
  }

  /** Change display presentation without touching deterministic universe state. */
  setNeonPhosphorMode(mode: NeonPhosphorMode): NeonPhosphorMode {
    const nextMode = normalizeNeonPhosphorMode(mode);
    this.neonPhosphorMode = this.post.setPhosphorMode(nextMode).mode;
    try {
      window.localStorage.setItem(NEON_PHOSPHOR_STORAGE_KEY, this.neonPhosphorMode);
    } catch {
      // Display preferences remain usable when browser storage is unavailable.
    }
    this.hud.notify(`NEON PHOSPHOR · ${this.neonPhosphorMode.toUpperCase()}`);
    return this.neonPhosphorMode;
  }

  private openDisplaySettings(): void {
    if (!this.displaySettings || this.graphicsReloadPending) return;
    this.displaySettings.open({
      graphicsQuality: this.graphicsQuality,
      effectiveQuality: this.host.capabilities.quality,
      backend: this.host.capabilities.backend,
      look: this.neonPhosphorMode,
    });
  }

  /** A native modal pauses flight; closing it cannot leave held thrust/roll keys stuck. */
  private onDisplaySettingsOpenChange(open: boolean): void {
    if (!this.inputRouter) return;
    if (open) this.inputRouter.setOwner('settings');
    else this.syncInputOwner();
  }

  /** Apply presentation live, or save before rebuilding all quality-dependent resources. */
  private applyDisplaySettings(values: DisplaySettingsValues): string | undefined {
    const nextQuality = normalizeGraphicsQuality(values.graphicsQuality);
    const nextLook = normalizeNeonPhosphorMode(values.look);
    if (nextQuality === this.graphicsQuality) {
      if (nextLook !== this.neonPhosphorMode) this.setNeonPhosphorMode(nextLook);
      return undefined;
    }

    if (this.gameplayEntered) {
      // The durable journey intentionally resumes in manual cruise. Do not
      // destroy an active real-distance intercept just to change graphics.
      if (this.flight.state.mode === 'pulse' || this.flight.state.mode === 'hyperdrive' ||
          this.flight.state.phase !== 'idle' || this.flight.getGuidance()?.departurePhase) {
        return 'Finish or cancel automated travel before changing graphics quality.';
      }
      if (!this.persistence.saveNow(this.simulationSeconds, Date.now(), this.localEffectsSeconds) ||
          !this.discoveries.flush()) {
        return 'Your journey could not be saved. Graphics quality has not changed.';
      }
    }

    let preferenceStored = false;
    try {
      window.localStorage.setItem(GRAPHICS_QUALITY_STORAGE_KEY, nextQuality);
      preferenceStored = true;
    } catch {
      // A launch-screen user can still select Low through the URL. In-flight
      // reloads reach here only after the genuine journey save succeeded.
    }
    if (nextLook !== this.neonPhosphorMode) this.setNeonPhosphorMode(nextLook);
    this.graphicsReloadPending = true;
    window.location.replace(graphicsQualityReloadUrl(window.location.href, nextQuality, preferenceStored));
    return undefined;
  }

  /** Change orbital and rotational time without changing real-time flight or local effects. */
  setCelestialTimeScale(scale: number): number {
    const nextScale = this.persistence.setCelestialTimeScale(scale);
    if (nextScale === this.celestialTimeScale) return nextScale;

    this.celestialTimeScale = nextScale;
    this.hud.notify(`CELESTIAL TIME · ${nextScale}× REAL TIME`);
    return nextScale;
  }

  /** Restore the genuine original Astris/Aurelia orbit from any system or flight state. */
  resetToStartingOrbit(): boolean {
    const heroSystem = this.catalog.heroSystem;
    const heroPlanet = this.catalog.heroPlanet;
    const snapshot = this.catalog.evaluateSystem(heroSystem, this.simulationSeconds);
    const heroPose = snapshot.poses.get(heroPlanet.id);
    if (!heroPose) return false;

    const position = {
      x: heroPose.localPositionMeters.x + heroPlanet.radiusMeters * 2.85 * 0.676458264,
      y: heroPose.localPositionMeters.y + heroPlanet.radiusMeters * 2.85 * 0.414011177,
      z: heroPose.localPositionMeters.z - heroPlanet.radiusMeters * 2.85 * 0.609096842,
    };
    const address = addAddressOffset(heroSystem.position, position);
    const previousSystemId = this.currentSystem.id;
    this.persistence.discardPendingSurfaceRestore();
    if (!this.flight.restoreState({
      position: serializeAddress(address),
      velocity: vec3(),
      yaw: 2.541212215,
      pitch: -0.192950023,
      systemId: heroSystem.id,
      targetId: heroPlanet.id,
    })) return false;

    for (const action of Object.keys(this.flight.input) as Array<keyof typeof this.flight.input>) {
      this.flight.setInput(action, false);
    }
    this.flight.state.velocity = vec3();
    this.flight.state.speedMetersPerSecond = 0;
    this.flight.state.throttle = 0;
    this.flight.state.roll = 0;
    this.flight.state.spoolProgress = 0;
    this.flight.state.travelProgress = 0;
    this.flight.state.nearestBodyId = heroPlanet.id;
    this.flight.state.altitudeMeters = heroPlanet.radiusMeters * 1.85;
    this.flight.steer(0, 0);

    this.currentSystem = heroSystem;
    this.discoveries.discoverSystem(heroSystem.id);
    this.discoveries.discoverBody(heroPlanet.id);
    this.surface.reconcileAfterDiscontinuity(this.simulationSeconds);
    if (previousSystemId !== heroSystem.id) this.buildSystem(heroSystem);
    this.bank = 0;
    this.hoveredTargetId = undefined;
    this.lastAutopilotPhase = undefined;
    this.pointerOrigin = undefined;
    this.mouseCaptured = false;
    this.cameraViewOffset = vec3();
    this.currentAtmosphereFactor = 0;
    this.currentTerrainTransition = 0;
    this.previouslyInsideCloud = false;
    this.previousCloudBodyId = undefined;
    this.camera.fov = 57;
    this.camera.updateProjectionMatrix();
    this.speedField.update(0, 0, 'cruise', 0, { landed: false, atmosphereDensity: 0 });
    this.simulationClock.reset(this.localEffectsSeconds);
    this.resetDemoPresentationFrame();
    this.updateMap();
    this.hud.setTargetLock?.(heroPlanet.id);
    if (this.hud.isMapOpen?.()) this.hud.toggleMap();
    if (this.viewMode === 'cockpit') this.updateCockpitRadar(snapshot);
    this.updateHud(snapshot.poses);
    this.persistence.saveActiveWaypoint(heroPlanet.id, this.simulationSeconds);
    this.persistence.saveNow(this.simulationSeconds, Date.now(), this.localEffectsSeconds);
    this.hud.notify(`ORBIT RESTORED · ${heroSystem.name.toUpperCase()} · ${heroPlanet.name.toUpperCase()}`);
    return true;
  }

  setDemoState(state: string) {
    if (!['orbit', 'pulse', 'boost', 'ring', 'descent', 'surface', 'landing', 'surface-approach',
      'far-side', 'target-surface', 'water-approach', 'geology-descent', 'river-surface',
      'lava-surface', 'frozen-surface'].includes(state)) return;
    this.beginQaDiscontinuity();
    if (state === 'geology-descent') {
      this.positionNearGeology();
      return;
    }
    if (state === 'river-surface' || state === 'lava-surface' || state === 'frozen-surface') {
      this.positionNearProceduralBiome(state);
      return;
    }
    const pose = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds).poses.get(this.catalog.heroPlanet.id);
    if (state === 'far-side' || state === 'target-surface' || state === 'water-approach' ||
        (!pose && ['landing', 'surface-approach', 'descent', 'surface'].includes(state))) {
      this.positionNearCurrentBody(state);
      return;
    }
    if (!pose) return;
    const radius = this.catalog.heroPlanet.radiusMeters;
    const scenario = createHeroScenarios(this.catalog, this.simulationSeconds);
    if (state === 'orbit') {
      this.flight.state.position = {
        x: pose.localPositionMeters.x + radius * 2.85 * 0.676458264,
        y: pose.localPositionMeters.y + radius * 2.85 * 0.414011177,
        z: pose.localPositionMeters.z - radius * 2.85 * 0.609096842,
      };
      this.flight.state.yaw = 2.541212215;
      this.flight.state.pitch = -0.192950023;
      this.flight.steer(0, 0);
      this.flight.setTarget(this.catalog.heroPlanet.id);
      this.flight.setMode('cruise');
    }
    if (state === 'descent' || state === 'surface') {
      if (state === 'descent') {
        // Showcase the actual coast within its real 1.7–6.0 km cloud
        // band. At the old 120 km entry altitude, genuine mountains and
        // cloud clusters were physically too distant to read on screen.
        const descentRadius = radius + scenario.surfaceHeightMeters + 5_600;
        this.flight.state.position = {
          x: pose.localPositionMeters.x + scenario.coastalDirection.x * descentRadius,
          y: pose.localPositionMeters.y + scenario.coastalDirection.y * descentRadius,
          z: pose.localPositionMeters.z + scenario.coastalDirection.z * descentRadius,
        };
      } else {
        this.flight.state.position = scenario.surfaceApproach;
      }
      this.flight.setTarget(this.catalog.heroPlanet.id);
      this.aimAcrossSurface(
        scenario.coastalDirection,
        state === 'descent'
          ? (this.host.capabilities.quality === 'fallback' ? 0.105 : 0.145)
          : 0.025,
        true,
        THREE.MathUtils.degToRad(state === 'descent' ? 47 : 38),
      );
      this.flight.setMode('cruise');
    }
    if (state === 'pulse') {
      // This explicit QA viewpoint must begin outside the real arrival shell.
      // The normal 2.85R launch already has the intended planetary framing.
      const startRadius = Math.max(radius * 4.5, pulseArrivalRadiusMeters(this.catalog.heroPlanet) * 1.6);
      const outward = new THREE.Vector3(0.676458264, 0.414011177, -0.609096842).normalize();
      this.flight.state.position = {
        x: pose.localPositionMeters.x + outward.x * startRadius,
        y: pose.localPositionMeters.y + outward.y * startRadius,
        z: pose.localPositionMeters.z + outward.z * startRadius,
      };
      this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
      this.flight.state.yaw = Math.atan2(outward.x, outward.z);
      this.flight.state.pitch = Math.asin(THREE.MathUtils.clamp(-outward.y, -1, 1));
      this.flight.steer(0, 0);
      this.flight.setTarget(this.catalog.heroPlanet.id);
      this.flight.setMode('pulse');
    }
    if (state === 'boost' || state === 'ring') {
      if (state === 'ring') {
        const tilt = this.catalog.heroPlanet.ring?.tiltRadians ?? 0;
        const ringNormal = rotateAroundYAxis({
          x: -Math.sin(tilt),
          y: Math.cos(tilt),
          z: 0,
        }, pose.rotationRadians);
        // Keep the actual night-side planet in view, but move out of its
        // umbra so a real star can illuminate the world-space ivory hull.
        // The positive ring-plane turn retains the approved diagonal annulus.
        const ringApproach = new THREE.Vector3(
          scenario.ringDirection.x, scenario.ringDirection.y, scenario.ringDirection.z,
        ).negate().applyAxisAngle(
          new THREE.Vector3(ringNormal.x, ringNormal.y, ringNormal.z),
          THREE.MathUtils.degToRad(35),
        );
        const ringApproachRadius = radius * 2.75;
        const ringPlaneClearance = radius * 0.065;
        this.flight.state.position = {
          x: pose.localPositionMeters.x + ringApproach.x * ringApproachRadius +
            ringNormal.x * ringPlaneClearance,
          y: pose.localPositionMeters.y + ringApproach.y * ringApproachRadius +
            ringNormal.y * ringPlaneClearance,
          z: pose.localPositionMeters.z + ringApproach.z * ringApproachRadius +
            ringNormal.z * ringPlaneClearance,
        };
        const planetward = new THREE.Vector3(
          pose.localPositionMeters.x - this.flight.state.position.x,
          pose.localPositionMeters.y - this.flight.state.position.y,
          pose.localPositionMeters.z - this.flight.state.position.z,
        ).normalize();
        this.flight.state.yaw = Math.atan2(-planetward.x, -planetward.z) + 0.32;
        this.flight.state.pitch = Math.asin(THREE.MathUtils.clamp(planetward.y, -1, 1)) - 0.14;
        this.flight.steer(0, 0);
        this.flight.setTarget(this.catalog.heroPlanet.id);
      }
      this.flight.setMode('boost');
    }
    if (state === 'landing' || state === 'surface-approach') {
      // Old reference captures need a genuinely parked view. Six metres leave
      // about 3.8 m below the authored feet for real deployment and contact.
      // The surface-approach fixture retains the full ninety-metre descent.
      const captureRadius = radius + scenario.surfaceHeightMeters + 6;
      this.flight.state.position = state === 'surface-approach' ? scenario.landingPosition : {
        x: pose.localPositionMeters.x + scenario.coastalDirection.x * captureRadius,
        y: pose.localPositionMeters.y + scenario.coastalDirection.y * captureRadius,
        z: pose.localPositionMeters.z + scenario.coastalDirection.z * captureRadius,
      };
      this.flight.setTarget(this.catalog.heroPlanet.id);
      this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
      this.flight.state.speedMetersPerSecond = 0;
      this.flight.state.velocity = vec3();
      this.flight.state.throttle = 0;
      this.flight.setMode('cruise');
      this.aimAcrossSurface(scenario.coastalDirection, 0, true, THREE.MathUtils.degToRad(36));
    }
    if (state !== 'pulse') this.flight.steer(0, 0);
    this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
    this.resetDemoPresentationFrame();
    if (state === 'landing') this.requestLanding();
  }

  /** A named QA/reset discontinuity is never used to implement a player landing. */
  private beginQaDiscontinuity(): void {
    this.persistence.discardPendingSurfaceRestore();
    this.inputRouter.clear();
    const saved = this.flight.serializeState();
    this.flight.restoreState({ ...saved, landedAnchor: undefined, velocity: vec3() });
    this.flight.clearInput();
    this.flight.state.roll = 0;
    this.surface.reconcileAfterDiscontinuity(this.simulationSeconds);
    this.surfaceFx.reset();
    this.syncInputOwner();
  }

  /** A QA viewpoint selected from real seeded mountains, never an extra scenery mesh. */
  private positionNearGeology() {
    const requested = this.flight.state.targetId
      ? this.catalog.getPlanet(this.flight.state.targetId)
      : undefined;
    const planet = requested?.systemId === this.currentSystem.id && requested.isLandable
      ? requested
      : this.currentSystem.planets.find((candidate) => candidate.isLandable);
    if (!planet) return;
    const visual = this.bodies.get(planet.id);
    const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds);
    const pose = snapshot.poses.get(planet.id);
    const star = snapshot.stars[0];
    if (!visual?.collision || !pose || !star) return;

    const sunward = new THREE.Vector3(
      star.localPositionMeters.x - pose.localPositionMeters.x,
      star.localPositionMeters.y - pose.localPositionMeters.y,
      star.localPositionMeters.z - pose.localPositionMeters.z,
    ).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -pose.rotationRadians);
    let best: {
      score: number;
      featureId: string;
      observer: THREE.Vector3;
      focus: THREE.Vector3;
      groundHeight: number;
      focusHeight: number;
      distanceMeters: number;
    } | undefined;

    const consider = (
      focus: THREE.Vector3,
      tangent: THREE.Vector3,
      distanceMeters: number,
      featureId?: string | null,
    ) => {
      // This is a photographic survey of existing geography and weather. It
      // never moves the sun, advances time, or manufactures a storm.
      if (focus.dot(sunward) < 0.18) return;
      const peak = samplePlanetClimate(visual.field, focus);
      if (peak.ocean || peak.heightMeters < 1_200) return;
      const angle = distanceMeters / planet.radiusMeters;
      const observer = focus.clone().multiplyScalar(Math.cos(angle))
        .addScaledVector(tangent, Math.sin(angle)).normalize();
      const ground = samplePlanetClimate(visual.field, observer);
      const groundHeight = ground.ocean ? 0 : ground.heightMeters;
      const relief = peak.heightMeters - groundHeight;
      if (relief < 800) return;
      const coastalWorld = planet.archetype === 'ocean' || planet.archetype === 'temperate';
      if (coastalWorld && (!ground.ocean || relief < 1_600)) return;
      const clouds = visual.weatherField.sample(observer, this.localEffectsSeconds);
      const shadowReceiver = observer.clone().multiplyScalar(planet.radiusMeters + groundHeight);
      const transmission = samplePlanetCloudTransmission(
        visual.weatherField,
        shadowReceiver,
        sunward,
        this.localEffectsSeconds,
        'high',
      );
      const fallbackTransmission = samplePlanetCloudTransmission(
        visual.weatherField, shadowReceiver, sunward, this.localEffectsSeconds, 'fallback',
      );
      if (visual.weatherField.supported && (clouds.density < 0.22 ||
        Math.max(transmission, fallbackTransmission) > 0.84)) return;
      const litStormEdge = visual.weatherField.supported
        ? (1 - Math.abs(transmission - 0.59)) * 700
          + (1 - Math.abs(clouds.density - 0.64)) * 550
          + clouds.stormIntensity * 480
        : 0;
      const score = relief * 0.82 + (peak.macroReliefMeters ?? 0) * 0.28
        + relief / Math.max(12_000, distanceMeters) * 14_000
        + (ground.ocean ? 310 : 0) + litStormEdge - distanceMeters * 0.018;
      if (!best || score > best.score) {
        best = { score, featureId: featureId ?? peak.geologyFeatureId ?? 'tectonic-range',
          observer, focus, groundHeight, focusHeight: peak.heightMeters, distanceMeters };
      }
    };
    const profile = createPlanetGeologyProfile(visual.field);
    for (const feature of profile.features) {
      if (feature.kind !== 'mountain-belt' && feature.kind !== 'ridge') continue;
      const center = new THREE.Vector3().copy(feature.centerDirection);
      const axis = new THREE.Vector3().copy(feature.axisDirection);
      for (const along of [-0.16, 0, 0.16]) {
        const focus = center.clone().addScaledVector(axis,
          along * feature.lengthMeters / planet.radiusMeters).normalize();
        const across = new THREE.Vector3().crossVectors(focus, axis).normalize();
        for (const side of [-1, 1]) for (const width of [0.42, 0.72, 1.05]) {
          consider(focus, across.clone().multiplyScalar(side),
            THREE.MathUtils.clamp(feature.widthMeters * width, 12_000, 68_000), feature.id);
        }
      }
    }
    // Named landmarks can all be on the night side. A bounded spherical
    // survey also finds the genuine connected tectonic ranges between them.
    for (let index = 0; index < 1_536; index += 1) {
      const y = 1 - 2 * (index + 0.5) / 1_536;
      const radial = Math.sqrt(1 - y * y);
      const azimuth = index * 2.399963229728653;
      const focus = new THREE.Vector3(Math.cos(azimuth) * radial, y, Math.sin(azimuth) * radial);
      if (focus.dot(sunward) < 0.18) continue;
      const peak = samplePlanetClimate(visual.field, focus);
      if (peak.ocean || peak.heightMeters < 1_600) continue;
      const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), focus).normalize();
      const north = new THREE.Vector3().crossVectors(focus, east).normalize();
      for (let bearing = 0; bearing < 8; bearing += 1) {
        const angle = bearing * Math.PI / 4;
        const tangent = east.clone().multiplyScalar(Math.cos(angle)).addScaledVector(north, Math.sin(angle));
        for (const distance of [12_000, 24_000, 44_000, 64_000]) {
          consider(focus, tangent, distance, peak.geologyFeatureId);
        }
      }
    }
    if (!best) {
      this.positionNearCurrentBody('descent');
      return;
    }

    const clearanceMeters = THREE.MathUtils.clamp(
      (best.focusHeight - best.groundHeight) * 0.49, 1_700, 2_300,
    );
    const observerWorld = rotateAroundYAxis(best.observer, pose.rotationRadians);
    const focusWorld = rotateAroundYAxis(best.focus, pose.rotationRadians);
    const observerRadius = planet.radiusMeters + best.groundHeight + clearanceMeters;
    this.flight.state.position = {
      x: pose.localPositionMeters.x + observerWorld.x * observerRadius,
      y: pose.localPositionMeters.y + observerWorld.y * observerRadius,
      z: pose.localPositionMeters.z + observerWorld.z * observerRadius,
    };
    const focusRadius = planet.radiusMeters + best.focusHeight;
    const forward = new THREE.Vector3(
      pose.localPositionMeters.x + focusWorld.x * focusRadius - this.flight.state.position.x,
      pose.localPositionMeters.y + focusWorld.y * focusRadius - this.flight.state.position.y,
      pose.localPositionMeters.z + focusWorld.z * focusRadius - this.flight.state.position.z,
    ).normalize().addScaledVector(new THREE.Vector3(
      observerWorld.x, observerWorld.y, observerWorld.z,
    ), -0.025).normalize();
    this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
    this.flight.state.velocity = vec3();
    this.flight.state.speedMetersPerSecond = 0;
    this.flight.state.throttle = 0;
    this.flight.state.yaw = Math.atan2(-forward.x, -forward.z);
    this.flight.state.pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
    this.flight.state.forward = { x: forward.x, y: forward.y, z: forward.z };
    this.flight.setTarget(planet.id);
    this.flight.setMode('cruise');
    this.flight.steer(0, 0);
    this.activateBodyTerrain(visual, best.observer);
    visual.group.userData.geographyShowcase = {
      featureId: best.featureId,
      observerDirection: best.observer.toArray(),
      focusDirection: best.focus.toArray(),
      focusHeightMeters: best.focusHeight,
      clearanceMeters,
      distanceMeters: best.distanceMeters,
    };
    this.resetDemoPresentationFrame();
  }

  /** Deterministic QA viewpoints over real sampled features; ordinary flight is unchanged. */
  private positionNearProceduralBiome(state: 'river-surface' | 'lava-surface' | 'frozen-surface') {
    const showcase = state === 'river-surface'
      ? {
        name: 'Serein Bloom',
        archetype: 'temperate',
        direction: new THREE.Vector3(
          0.9518484237473115,
          -0.28645833333333326,
          -0.10920714937057692,
        ),
      }
      : state === 'lava-surface'
        ? {
          name: 'Cinder Wake',
          archetype: 'volcanic',
          direction: new THREE.Vector3(
            -0.30393277659346274,
            0.8489583333333334,
            0.43231309901051707,
          ),
        }
        : {
          name: 'Hushglass',
          archetype: 'frozen',
          direction: new THREE.Vector3(
            -0.527708681439,
            0.659375,
            -0.535488708479,
          ),
        };
    const candidates = this.currentSystem.planets.flatMap((planet) => [planet, ...planet.moons]);
    const body = candidates.find((candidate) => candidate.name === showcase.name) ??
      candidates.find((candidate) => candidate.archetype === showcase.archetype && candidate.isLandable);
    if (!body) return;
    const visual = this.bodies.get(body.id);
    const pose = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds).poses.get(body.id);
    if (!visual?.collision || !pose) return;

    const bodyFixed = showcase.direction.normalize();
    const sampled = visual.collision.sample(bodyFixed);
    if (sampled.ocean) return;
    const worldDirection = rotateAroundYAxis(bodyFixed, pose.rotationRadians);
    const trueSurfaceRadius = body.radiusMeters + sampled.heightMeters;
    const clearanceMeters = 250;
    this.flight.state.position = {
      x: pose.localPositionMeters.x + worldDirection.x * (trueSurfaceRadius + clearanceMeters),
      y: pose.localPositionMeters.y + worldDirection.y * (trueSurfaceRadius + clearanceMeters),
      z: pose.localPositionMeters.z + worldDirection.z * (trueSurfaceRadius + clearanceMeters),
    };
    this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
    this.flight.state.velocity = vec3();
    this.flight.state.speedMetersPerSecond = 0;
    this.flight.state.throttle = 0;
    this.flight.setTarget(body.id);
    this.flight.setMode('cruise');
    this.activateBodyTerrain(visual, bodyFixed);
    const authenticFlow = state === 'river-surface' && sampled.riverDirection
      ? new THREE.Vector3(
        sampled.riverDirection.x,
        sampled.riverDirection.y,
        sampled.riverDirection.z,
      )
      : state === 'lava-surface'
        ? new THREE.Vector3().crossVectors(bodyFixed, new THREE.Vector3(0, 1, 0))
        : state === 'frozen-surface'
          ? new THREE.Vector3(
            0.8309115284818838,
            0.5316129275021555,
            -0.16423680205266944,
          )
          : undefined;
    if (authenticFlow && authenticFlow.lengthSq() > 0.000_01) {
      const worldFlow = authenticFlow
        .addScaledVector(bodyFixed, -authenticFlow.dot(bodyFixed))
        .normalize()
        .applyAxisAngle(
          bodyFixed,
          state === 'river-surface' ? 0.11 : state === 'lava-surface' ? -0.12 : 0,
        )
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), pose.rotationRadians);
      const forward = worldFlow.addScaledVector(
        new THREE.Vector3(worldDirection.x, worldDirection.y, worldDirection.z),
        state === 'frozen-surface' ? -0.10 : -0.14,
      ).normalize();
      this.flight.state.yaw = Math.atan2(-forward.x, -forward.z);
      this.flight.state.pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
      this.flight.state.forward = { x: forward.x, y: forward.y, z: forward.z };
    } else {
      this.aimAcrossSurface(worldDirection, 0.11, true);
    }
    this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
    this.resetDemoPresentationFrame();
  }

  private positionNearCurrentBody(state: string) {
    const requested = this.flight.state.targetId ? this.catalog.getPlanet(this.flight.state.targetId) : undefined;
    const body = state === 'far-side'
      ? this.catalog.heroPlanet
      : requested?.systemId === this.currentSystem.id && requested.isLandable
        ? requested
        : this.currentSystem.planets.find((candidate) => candidate.isLandable);
    if (!body) return;
    const visual = this.bodies.get(body.id);
    const pose = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds).poses.get(body.id);
    if (!visual?.collision || !pose) return;

    let preferred = new THREE.Vector3(0.42, 0.62, 0.66).normalize();
    if (state === 'far-side') {
      const showcase = createHeroScenarios(this.catalog, this.simulationSeconds);
      preferred.copy(new THREE.Vector3(
        showcase.bodyFixedCoastalDirection.x,
        showcase.bodyFixedCoastalDirection.y,
        showcase.bodyFixedCoastalDirection.z,
      )).multiplyScalar(-1);
    }

    let bodyFixed = visual.collision.findCoastalLandingDirection(preferred, 160) ?? preferred;
    if (state === 'water-approach') {
      for (let index = 0; index < 256; index++) {
        const candidate = new THREE.Vector3(
          Math.sin(index * 2.39996323) * Math.sqrt(1 - ((index + 0.5) / 128 - 1) ** 2),
          (index + 0.5) / 128 - 1,
          Math.cos(index * 2.39996323) * Math.sqrt(1 - ((index + 0.5) / 128 - 1) ** 2),
        ).normalize();
        if (visual.collision.sample(candidate).ocean) {
          bodyFixed = candidate;
          break;
        }
      }
    }

    const worldDirection = rotateAroundYAxis(bodyFixed, pose.rotationRadians);
    const surfaceSample = visual.collision.sample(bodyFixed);
    const surfaceHeight = surfaceSample.ocean ? 0 : surfaceSample.heightMeters;
    const shouldLand = state === 'landing' || state === 'far-side';
    const altitude = shouldLand ? 6
      : state === 'surface-approach' || state === 'water-approach' ? 90
      : state === 'descent'
        ? Math.max(9_000, body.atmosphere.heightMeters * 0.82)
        : 2_200;
    this.flight.state.position = {
      x: pose.localPositionMeters.x + worldDirection.x * (body.radiusMeters + surfaceHeight + altitude),
      y: pose.localPositionMeters.y + worldDirection.y * (body.radiusMeters + surfaceHeight + altitude),
      z: pose.localPositionMeters.z + worldDirection.z * (body.radiusMeters + surfaceHeight + altitude),
    };
    this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
    this.flight.state.velocity = vec3();
    this.flight.state.speedMetersPerSecond = 0;
    this.flight.state.throttle = 0;
    this.flight.setTarget(body.id);
    this.flight.setMode('cruise');
    this.activateBodyTerrain(visual, bodyFixed);
    this.aimAcrossSurface(worldDirection, shouldLand || state === 'surface-approach' ? 0 : 0.055, true);
    this.flight.state.address = addAddressOffset(this.currentSystem.position, this.flight.state.position);
    this.resetDemoPresentationFrame();
    if (shouldLand) this.requestLanding();
  }

  /** Explicit showcase teleports establish the physical frame; ordinary flight always blends continuously. */
  private resetDemoPresentationFrame() {
    this.persistence.discardPendingSurfaceRestore();
    this.surface.reconcileAfterDiscontinuity(this.simulationSeconds);
    this.flight.snapReferenceFrame(this.simulationSeconds);
    this.prepareSurfaceContact();
    this.surfaceFx.reset();
    this.resetRenderHistory('teleport');
    this.updateRenderObserver(0);
    this.syncInputOwner();
    this.cameraAngularDelta = 0;
  }

  private aimAcrossSurface(
    direction: { x: number; y: number; z: number },
    downward: number,
    towardSuns = false,
    azimuthRadians = 0,
  ) {
    const radial = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    let tangent: THREE.Vector3;
    if (towardSuns) {
      const snapshot = this.catalog.evaluateSystem(this.currentSystem, this.simulationSeconds);
      const sunward = new THREE.Vector3();
      for (const star of snapshot.stars) {
        sunward.add(new THREE.Vector3(
          star.localPositionMeters.x - this.flight.state.position.x,
          star.localPositionMeters.y - this.flight.state.position.y,
          star.localPositionMeters.z - this.flight.state.position.z,
        ).normalize());
      }
      tangent = sunward.addScaledVector(radial, -sunward.dot(radial)).normalize();
    } else {
      const reference = Math.abs(radial.y) > 0.88
        ? new THREE.Vector3(0, 0, -1)
        : new THREE.Vector3(0, 1, 0);
      tangent = new THREE.Vector3().crossVectors(reference, radial).normalize();
    }
    const forward = tangent
      .applyAxisAngle(radial, azimuthRadians)
      .addScaledVector(radial, -downward)
      .normalize();
    this.flight.state.yaw = Math.atan2(-forward.x, -forward.z);
    this.flight.state.pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
    this.flight.state.forward = { x: forward.x, y: forward.y, z: forward.z };
  }

  dispose() {
    cancelAnimationFrame(this.animationFrame);
    this.cancelPointerUnlockPause();
    this.graphicsReloadPending = true;
    // Persist the real outside actor before session disposal returns it inside.
    if (this.gameplayEntered && this.surface) this.persistence?.dispose();
    else this.persistence?.detachPagehide();
    this.displaySettings?.dispose();
    this.pauseMenu?.dispose();
    this.parent.classList.remove('expedition-paused');
    this.launchScreen?.dispose();
    this.inputRouter?.dispose();
    this.flight?.dispose();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.host?.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.host?.renderer.domElement.removeEventListener('wheel', this.onFlightWheel);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('blur', this.onInputBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    this.surface?.dispose();
    for (const body of this.bodies.values()) {
      this.releaseBodyTerrain(body);
      body.proxyLod.dispose();
      body.visibility.dispose();
      this.disposeBodyRenderResources(body);
      body.weatherNodes.dispose();
    }
    for (const star of this.stars.values()) this.disposeObjectResources(star);
    if (this.nebula) this.disposeObjectResources(this.nebula);
    this.contactAuthority?.dispose();
    this.terrainJobs?.dispose();
    this.starfield?.dispose();
    this.speedField?.dispose();
    this.gpuTerrain?.dispose();
    this.post?.dispose();
    this.shipOverlay?.dispose();
    this.surfaceFx?.dispose();
    this.worldShip?.dispose();
    this.ship?.dispose();
    this.surfaceOverlay?.dispose();
    this.cockpitOverlay?.dispose();
    this.hud?.dispose();
    this.host?.dispose();
    delete window.__VOID_EXPLORER__;
  }
}
