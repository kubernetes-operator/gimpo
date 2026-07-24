import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 개발 시 /api 요청을 백엔드(:3000)로 프록시. 백엔드 포트는 BACKEND_PORT 로 조정.
const backendPort = process.env.BACKEND_PORT ?? '3000';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${backendPort}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
