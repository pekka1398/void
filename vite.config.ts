import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** Dev server only: POST /__lab-log/<stream> appends the body to lab-log/<stream>.jsonl (see lab/landing/src/debug/LabLog.ts). */
function labLog(): Plugin {
  const directory = fileURLToPath(new URL('./lab/flight/lab-log', import.meta.url));
  return {
    name: 'lab-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__lab-log/', (request, response) => {
        const stream = (request.url ?? '').replace(/^\//, '');
        if (request.method !== 'POST' || !/^[a-z0-9-]+$/.test(stream)) {
          response.statusCode = 400;
          response.end(`lab-log: bad request ${request.method} ${JSON.stringify(stream)}`);
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          mkdirSync(directory, { recursive: true });
          appendFileSync(resolve(directory, `${stream}.jsonl`), Buffer.concat(chunks));
          response.statusCode = 204;
          response.end();
        });
      });
    },
  };
}

// lab/lod's and lab/landing's modules import three from their own node_modules; one copy must serve every lab.
export default defineConfig({
  plugins: [labLog()],
  resolve: { dedupe: ['three'] },
  // Scan only this app's entry; unrelated lab and decompile pages are not game entries.
  optimizeDeps: { entries: ['index.html'] },
  // Both the game and flight lab serve shared modules and terrain workers from this repository.
  server: { fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] } },
});
