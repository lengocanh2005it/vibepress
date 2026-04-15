import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = env.VITE_API_PORT || '3100';

  return {
    plugins: [react()],
    cacheDir: '.vite',
    server: {
      port: parseInt(env.VITE_PORT || '5173', 10),
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
