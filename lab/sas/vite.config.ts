import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The page builds lab/landing's rocket (its modules import three and Rapier from lab/landing/node_modules); one copy must serve both labs.
export default defineConfig({
  resolve: { dedupe: ['three', '@dimforge/rapier3d-compat'] },
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
});
