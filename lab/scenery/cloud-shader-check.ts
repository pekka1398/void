import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
// @ts-expect-error internal GLSL builder has no public declaration
import GLSLNodeBuilder from 'three/src/renderers/webgl-fallback/nodes/GLSLNodeBuilder.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AtmosphereShading } from './src/AtmosphereNodes';
import { SceneryPipeline } from './src/SceneryPipeline';
import { CloudShading } from './src/CloudNodes';
import { earthLikeAtmosphere } from './src/Atmosphere';
import { GroundMaterial } from './src/GroundMaterial';
const renderer = new THREE.WebGPURenderer({ forceWebGL: true,
  canvas: { width: 16, height: 16, style: {}, addEventListener() {} } as unknown as HTMLCanvasElement });
const backend = renderer.backend as unknown as { extensions: unknown; capabilities: unknown };
backend.extensions = { has: () => false, get: () => null };
backend.capabilities = { getUniformBufferLimit: () => 65536 };
const atmosphere = new AtmosphereShading(earthLikeAtmosphere(6371000));
const clouds = new CloudShading(atmosphere);
const material = new THREE.MeshBasicNodeMaterial();
const transport = atmosphere.transport(texture(new THREE.DepthTexture(16, 16)), clouds);
material.colorNode = transport.evaluate;
material.outputNode = transport.output;
renderer.setRenderTarget(new THREE.RenderTarget(16, 16, { count: 2, type: THREE.HalfFloatType }));
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
const builder = new GLSLNodeBuilder(mesh, renderer);
builder.camera = new THREE.PerspectiveCamera();
builder.build();
if (!builder.fragmentShader.includes('sampler3D')) throw new Error('cloud volume absent from generated GLSL');
// Catch nested-index shadowing in the generated code, not merely TypeScript validity.
const loopNames = [...builder.fragmentShader.matchAll(/for \( int (\w+) =/g)].map(match => match[1]);
if (loopNames.length !== 3 || new Set(loopNames).size !== loopNames.length) {
  throw new Error(`transport loops must have distinct indices: ${loopNames.join(', ')}`);
}
// Depth uses its single, non-mipmapped level. Volume and LUT samples use explicit LOD.
const implicitSamplers = new Set([...builder.fragmentShader.matchAll(/\btexture\(\s*(\w+)\s*,/g)].map(match => match[1]));
if (implicitSamplers.size !== 1) throw new Error('transport contains implicit-LOD volume/LUT sampling');
writeFileSync(join(process.argv[2]!, 'scenery-cloud.vert'), builder.vertexShader);
writeFileSync(join(process.argv[2]!, 'scenery-cloud.frag'), builder.fragmentShader);
console.log(`Cloud composite GLSL generated: ${builder.fragmentShader.length} bytes; ${clouds.buildMilliseconds.toFixed(0)} ms noise build`);

const pipeline = new SceneryPipeline(renderer, atmosphere, clouds);
const resolveMaterial = new THREE.MeshBasicNodeMaterial();
resolveMaterial.fragmentNode = pipeline.outputNode;
renderer.setRenderTarget(null);
const resolveBuilder = new GLSLNodeBuilder(new THREE.QuadMesh(resolveMaterial), renderer);
resolveBuilder.camera = new THREE.PerspectiveCamera();
resolveBuilder.build();
writeFileSync(join(process.argv[2]!, 'scenery-resolve.vert'), resolveBuilder.vertexShader);
writeFileSync(join(process.argv[2]!, 'scenery-resolve.frag'), resolveBuilder.fragmentShader);
console.log(`Full-resolution resolve GLSL generated: ${resolveBuilder.fragmentShader.length} bytes`);

// Build the actual batched terrain material as well, including the inertial-scene frame adapter.
const ground = new GroundMaterial(atmosphere, 7600, 9800);
const geometry = new THREE.PlaneGeometry(2, 2);
const vertices = geometry.getAttribute('position').count;
geometry.setAttribute('height', new THREE.BufferAttribute(new Float32Array(vertices).fill(5100), 1));
geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertices * 3).fill(0.2), 3));
const batch = new THREE.BatchedMesh(1, vertices, geometry.index!.count, ground.material);
batch.addInstance(batch.addGeometry(geometry));
const groundBuilder = new GLSLNodeBuilder(batch, renderer);
groundBuilder.camera = new THREE.PerspectiveCamera();
groundBuilder.build();
writeFileSync(join(process.argv[2]!, 'scenery-ground.vert'), groundBuilder.vertexShader);
writeFileSync(join(process.argv[2]!, 'scenery-ground.frag'), groundBuilder.fragmentShader);
console.log(`Batched ground GLSL generated: ${groundBuilder.fragmentShader.length} bytes`);
