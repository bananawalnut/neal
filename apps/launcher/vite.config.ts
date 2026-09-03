import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 4290,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4291,
    strictPort: true,
  },
});
