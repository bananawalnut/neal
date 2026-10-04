import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4282,
    strictPort: true,
    allowedHosts: ['localhost', '127.0.0.1'],
  },
  preview: {
    host: '127.0.0.1',
    port: 4282,
    strictPort: true,
    allowedHosts: ['localhost', '127.0.0.1'],
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(siteRoot, 'index.html'),
        admin: resolve(siteRoot, 'admin/index.html'),
      },
    },
  },
});
