import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const r = (p: string) => resolve(process.cwd(), p)

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': r('src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: r('src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': r('src/renderer/src'),
        '@shared': r('src/shared'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
