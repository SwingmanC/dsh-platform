import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// dev 代理:/api、/auth、/app 全部转发网关,浏览器只见一个 origin,cookie 天然同域。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
      '/app': { target: 'http://127.0.0.1:8080', ws: true },
    },
  },
})
