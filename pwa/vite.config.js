import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      base: '/janitor/',
      scope: '/janitor/',
      manifest: false, // используем наш manifest.json
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        navigateFallback: '/janitor/',
        navigateFallbackDenylist: [/^\/janitor\/api/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/smilart\.ru\/janitor\/api\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 }
            }
          }
        ]
      }
    })
  ],
  base: '/janitor/',
  server: {
    proxy: {
      '/janitor/api': {
        target: 'https://smilart.ru',
        changeOrigin: true,
        secure: true,
      },
      '/janitor/ws': {
        target: 'wss://smilart.ru',
        ws: true,
        changeOrigin: true,
        secure: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})