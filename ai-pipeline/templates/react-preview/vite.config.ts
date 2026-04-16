import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = env.VITE_API_PORT || '3100';
  const base = env.VITE_BASE || '/';

  const proxy: Record<string, object> = {
    '/api': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
    },
  };

  // Khi chạy qua proxy chain, API calls đến /{base}api/... thay vì /api/...
  if (base !== '/') {
    proxy[`${base}api`] = {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(`${base}api`, '/api'),
    };
  }

  return {
    plugins: [react()],
    base,
    cacheDir: '.vite',
    server: {
      port: parseInt(env.VITE_PORT || '5173', 10),
      host: '0.0.0.0',
      allowedHosts: true,
      proxy,
    },
  };
});
