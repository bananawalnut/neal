import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = dirname(fileURLToPath(import.meta.url));
const adminMonitorProxy = {
  target: 'https://matrix.nealtheseal.org',
  changeOrigin: true,
  secure: true,
  headers: {
    Origin: 'https://nealtheseal.org',
  },
};

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4280,
    proxy: {
      '^/_neal/admin/(users|server)$': adminMonitorProxy,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4280,
    proxy: {
      '^/_neal/admin/(users|server)$': adminMonitorProxy,
    },
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
