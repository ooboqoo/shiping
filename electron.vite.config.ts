import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        // The region picker has its own page, so its windows load none of the app
        input: {
          index: resolve('src/renderer/index.html'),
          picker: resolve('src/renderer/picker.html')
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
