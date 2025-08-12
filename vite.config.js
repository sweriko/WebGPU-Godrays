import { defineConfig } from 'vite'
import { copyFileSync, existsSync } from 'fs'
import { resolve } from 'path'

export default defineConfig({
  root: '.',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  optimizeDeps: {
    include: [
      'three',
      '@dimforge/rapier3d-compat',
      'lil-gui',
    ],
  },
  assetsInclude: ['**/*.gltf', '**/*.glb', '**/*.fbx', '**/*.obj', '**/*.wasm'],
  plugins: [
    {
      name: 'copy-glb',
      writeBundle() {
        const src = resolve('cathedral.glb')
        const dest = resolve('dist/cathedral.glb')
        if (existsSync(src)) {
          copyFileSync(src, dest)
        }
      }
    }
  ]
})