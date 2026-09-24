import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        lodLab: resolve(import.meta.dirname, 'lab/lod/index.html'),
      },
    },
  },
});
