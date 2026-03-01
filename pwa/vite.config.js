import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],

  base: '/janitor/',

  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        // Основное PWA — /janitor/
        main: resolve(__dirname, 'index.html'),
        // Суперадмин — /janitor/superadmin/
        superadmin: resolve(__dirname, 'superadmin.html'),
      }
    }
  },

  server: {
    proxy: {
      '/janitor/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      }
    }
  }
})