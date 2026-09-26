import { defineConfig } from 'vite';

// lab/lod's and lab/landing's modules import three from their own node_modules; one copy must serve every lab.
export default defineConfig({
  resolve: { dedupe: ['three'] },
  // The terrain tile worker lives in lab/landing; the dev server must serve it from there.
  server: { fs: { allow: ['..'] } },
});
