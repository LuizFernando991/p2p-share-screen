import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Native module (optional dependency, so not externalized by default):
        // bundling it breaks how it locates its prebuilt binary.
        external: ['@vencord/venmic']
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
