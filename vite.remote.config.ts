// The mobile panel — a standalone web app served by the loopback RemoteServer
// over Tailscale Serve. Built separately from the Electron renderer; the output
// is static assets the main process streams from out/remote. `base: './'` keeps
// asset URLs relative so it works behind whatever path Tailscale mounts it on.
import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: path.resolve(__dirname, 'src/remote-app'),
  base: './',
  build: {
    outDir: path.resolve(__dirname, 'out/remote'),
    emptyOutDir: true,
    target: 'es2020',
  },
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'src/shared') },
  },
})
