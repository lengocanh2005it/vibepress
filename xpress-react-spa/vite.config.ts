import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_BACKEND_URL || 'http://localhost:5000'
  const wpUrl      = env.VITE_WP_URL      || 'http://localhost:8000'
  const aiProxyTarget =
    env.VITE_BACKEND_AI_PROXY_TARGET ||
    (env.VITE_BACKEND_AI_URL?.startsWith('http')
      ? env.VITE_BACKEND_AI_URL
      : 'http://localhost:3001')

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/ai-api': {
          target: aiProxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ai-api/, ''),
        },
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
        // WP static assets — proxy same-origin để tránh CORS (font, CSS, JS, images)
        '/wp-content': {
          target: wpUrl,
          changeOrigin: true,
        },
        '/wp-includes': {
          target: wpUrl,
          changeOrigin: true,
        },
      },
    },
  }
})
