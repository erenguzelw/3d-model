import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: { port: 5173 },
});
