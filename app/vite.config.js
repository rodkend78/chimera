import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cp } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const LIVE_VIEW_ROOT = resolve(APP_DIR, '../node_modules/bedrock-agentcore/dist/src/tools/browser/live-view/nice-dcv-web-client-sdk')

function copyDcvAssets() {
  return {
    name: 'chimera-copy-agentcore-dcv-assets',
    apply: 'build',
    async closeBundle() {
      await cp(LIVE_VIEW_ROOT, resolve(APP_DIR, 'dist/nice-dcv-web-client-sdk'), { recursive: true, force: true })
    },
  }
}

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  // The repository-level .env is the single operator configuration boundary.
  // Vite exposes only VITE_-prefixed values to the browser bundle.
  envDir: resolve(APP_DIR, '..'),
  plugins: [react(), copyDcvAssets()],
  resolve: {
    alias: {
      dcv: resolve(LIVE_VIEW_ROOT, 'dcvjs-esm/dcv.js'),
      'dcv-ui': resolve(LIVE_VIEW_ROOT, 'dcv-ui/dcv-ui.js'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4174',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
