import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs'

// Build output directory, resolved relative to the process CWD by the Go
// server (internal/frontend). Deliberately distinctive so it can never collide
// with an unrelated directory on a real machine — a generic name such as
// "public" matches macOS's ~/Public on a case-insensitive volume, which once
// made the server serve an empty directory and every page 404.
const outDir = resolve(__dirname, '.clawterm-web')
const srcAssets = resolve(__dirname, 'assets')

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
if (existsSync(srcAssets)) {
  const outAssets = resolve(outDir, 'assets')
  if (!existsSync(outAssets)) mkdirSync(outAssets, { recursive: true })
  for (const f of readdirSync(srcAssets)) {
    cpSync(resolve(srcAssets, f), resolve(outAssets, f), { force: true })
  }
}

export default defineConfig({
  root: resolve(__dirname, 'web'),
  plugins: [vue()],
  resolve: {
    alias: { '@': resolve(__dirname, 'web/src') },
  },
  build: {
    outDir,
    emptyOutDir: false, // keeps assets/ (icons, manifest) written above
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          // xterm is large and only needed once a terminal is opened.
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-search'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:20077',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: [resolve(__dirname, 'web/src/test-setup.ts')],
  },
})
