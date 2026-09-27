// Build with one copy of Three's source modules: mixing its bundled TSL with its
// source GLSL builder gives two independent shader stacks. No browser is needed.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'scenery-cloud-shader-'));
const bundle = join(output, 'check.mjs');
await build({ entryPoints: [join(root, 'cloud-shader-check.ts')], bundle: true, platform: 'node', format: 'esm',
  alias: { 'three/webgpu': join(root, 'node_modules/three/src/Three.WebGPU.js'),
    'three/tsl': join(root, 'node_modules/three/src/Three.TSL.js') }, outfile: bundle });
execFileSync(process.execPath, [bundle, output], { stdio: 'inherit' });
console.log(`GLSL files: ${output}`);
