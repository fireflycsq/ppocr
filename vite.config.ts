import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/auth': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/api/label': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/api/llm': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        timeout: 1800000,
        rewrite: (path) => path.replace(/^\/api\/llm/, ''),
      },
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        timeout: 600000,
      },
      '/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
