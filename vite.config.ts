import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs'

// Build output. The Go server is gone, so this directory is only a staging area
// that `npm run build` copies into the APK's assets — the app has no server to
// serve it from.
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
  // Relative asset URLs: the page is loaded from file:///android_asset/web/, so
  // an absolute "/assets/..." path would resolve to the filesystem root and
  // every chunk would 404.
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': resolve(__dirname, 'web/src') },
  },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'es2020',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Deterministic names: a file:// URL has no cache headers, and a stale
        // hashed chunk after an in-place update is the classic "white screen
        // after upgrade" — there is no server to 404 and trigger a reload.
        entryFileNames: 'js/[name].js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: 'assets/[name][extname]',
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/addon-search'],
        },
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
