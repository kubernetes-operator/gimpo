import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 개발 시 /api 요청을 백엔드(:3000)로 프록시. 백엔드 포트는 BACKEND_PORT 로 조정.
const backendPort = process.env.BACKEND_PORT ?? '3000';

// 게이트웨이가 test2.studiobasa.com/velero/ 서브패스로 서빙하므로 프로덕션 빌드는
// base=/velero/ 로 자산·라우트를 프리픽스한다. (게이트웨이가 /velero 프리픽스를 제거해
// 백엔드로 넘기므로 백엔드 코드는 루트 그대로 유지) BASE_PATH 로 재정의 가능.
const basePath = process.env.BASE_PATH ?? '/velero/';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? basePath : '/',
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
}));
