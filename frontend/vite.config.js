import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    include: ['@novnc/novnc/lib/rfb'],
    // @novnc uses top-level await; esbuild's default dev target (es2020)
    // rejects it. Match the build target so dev pre-bundling succeeds.
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    fs: {
      allow: [resolve(currentDir, '..')],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
