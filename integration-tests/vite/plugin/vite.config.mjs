import { builtinModules } from 'node:module'

import { defineConfig, version } from 'vite'

import { datadogVite } from 'dd-trace/vite.js'

// ssr: an SSR build (server consumer). lib: a Node.js library build (client consumer), shaped like the main process
// build of Electron Forge, minified.
const shape = process.env.VITE_SHAPE ?? 'ssr'
// bundled: every dependency, dd-trace included, is bundled. list: only the instrumented packages are bundled.
// external: Vite's default externalization of node_modules.
const dependencies = process.env.VITE_DEPENDENCIES ?? 'bundled'
const format = process.env.VITE_OUTPUT_FORMAT ?? 'cjs'
const extension = format === 'es' ? 'mjs' : 'cjs'
const builtins = builtinModules.flatMap(name => [name, `node:${name}`])
const noExternal = {
  bundled: true,
  list: ['ai', '@langchain/langgraph', 'express'],
  external: undefined,
}[dependencies]

export default defineConfig({
  plugins: [datadogVite()],
  logLevel: 'warn',
  build: {
    outDir: process.env.VITE_OUT_DIR,
    emptyOutDir: true,
    ...(shape === 'lib'
      ? {
          minify: true,
          lib: { entry: 'server.mjs', formats: [format], fileName: () => `server.${extension}` },
        }
      : { ssr: 'server.mjs' }),
    rollupOptions: {
      // Vite 6 cannot bundle built-ins with `ssr.noExternal: true` unless they are external.
      external: shape === 'lib' || version.startsWith('6.') ? builtins : undefined,
      output: {
        format,
        entryFileNames: `server.${extension}`,
        chunkFileNames: `[name]-[hash].${extension}`,
      },
    },
  },
  ...(shape === 'lib'
    ? { resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] } }
    : { ssr: { noExternal } }),
})
