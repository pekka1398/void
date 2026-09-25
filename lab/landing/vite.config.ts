import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** Dev server only: POST /__lab-log/<stream> appends the body to lab-log/<stream>.jsonl (see src/debug/LabLog.ts). */
function labLog(): Plugin {
  const directory = fileURLToPath(new URL('./lab-log', import.meta.url));
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

// lab/lod's core imports three from lab/lod/node_modules; one copy must serve both labs.
export default defineConfig({
  plugins: [labLog()],
  resolve: { dedupe: ['three'] },
});
