import { defineConfig } from 'vite';

export default defineConfig({
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

