import * as THREE from 'three/webgpu';
import { Fn, texture, vec4 } from 'three/tsl';
import type { AtmosphereShading } from './AtmosphereNodes';
import type { CloudShading } from './CloudNodes';

/** Scene and joint air/cloud integration always use the same full resolution. */
export class SceneryPipeline {
  private readonly sceneTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1), depthBuffer: true,
  });
  private readonly mediumTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType, count: 2, depthBuffer: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private readonly mediumMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  private readonly mediumQuad = new THREE.QuadMesh(this.mediumMaterial);
  private readonly display: THREE.RenderPipeline;
  readonly outputNode: THREE.Node<'vec4'>;
  /** Scene counts before the transport and resolve passes reset renderer.info. */
  readonly sceneStats = { drawCalls: 0, triangles: 0 };

  constructor(private readonly renderer: THREE.WebGPURenderer, atmosphere: AtmosphereShading, clouds: CloudShading) {
    const depth = texture(this.sceneTarget.depthTexture!);
    const transport = atmosphere.transport(depth, clouds);
    this.mediumMaterial.colorNode = transport.evaluate;
    this.mediumMaterial.outputNode = transport.output;
    this.display = new THREE.RenderPipeline(renderer);
    this.outputNode = Fn(() => {
      const illumination = texture(this.mediumTarget.textures[0]!).rgb;
      const transmission = texture(this.mediumTarget.textures[1]!).rgb;
      return vec4(texture(this.sceneTarget.texture).rgb.add(atmosphere.sunDisc(depth))
        .mul(transmission).add(illumination), 1);
    })();
    this.display.outputNode = this.outputNode;
  }

  resize(width: number, height: number): void {
    this.sceneTarget.setSize(width, height);
    this.mediumTarget.setSize(width, height);
  }

  get needsUpdate(): boolean { return this.display.needsUpdate; }
  set needsUpdate(value: boolean) { this.display.needsUpdate = value; }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.sceneTarget);
    renderer.render(scene, camera);
    this.sceneStats.drawCalls = renderer.info.render.drawCalls;
    this.sceneStats.triangles = renderer.info.render.triangles;
    renderer.setRenderTarget(this.mediumTarget);
    this.mediumQuad.render(renderer);
    renderer.setRenderTarget(null);
    this.display.render();
  }
}
