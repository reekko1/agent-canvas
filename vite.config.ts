// Renderer Vite config. Consumed by electron-vite (see electron.vite.config.ts)
// and detected by tooling that expects a standard Vite project (e.g. shadcn).
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer/src'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
})
