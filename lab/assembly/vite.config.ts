import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { dedupe: ['three', '@dimforge/rapier3d-compat'] },
  optimizeDeps: { entries: ['index.html'] },
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } } });
