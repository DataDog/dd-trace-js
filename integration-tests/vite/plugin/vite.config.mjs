import { builtinModules } from 'node:module'

import { defineConfig, version } from 'vite'

import { datadogVite } from 'dd-trace/vite.js'

// bundled: every dependency, dd-trace included, is bundled. list: only the instrumented packages are bundled.
const dependencies = process.env.VITE_DEPENDENCIES ?? 'bundled'
const format = process.env.VITE_OUTPUT_FORMAT ?? 'cjs'
// A second SSR entry initializing the tracer moves the tracer into a chunk shared by both entries.
const split = process.env.VITE_SPLIT === 'true'
const extension = format === 'es' ? 'mjs' : 'cjs'
const builtins = builtinModules.flatMap(name => [name, `node:${name}`])
const noExternal = {
  bundled: true,
  list: ['ai', '@langchain/langgraph', 'express', 'hono'],
}[dependencies]

export default defineConfig({
  plugins: [datadogVite()],
  logLevel: 'warn',
  build: {
    outDir: process.env.VITE_OUT_DIR,
    emptyOutDir: true,
    ssr: split ? true : 'server.mjs',
    rollupOptions: {
      // Vite 6 cannot bundle built-ins with `ssr.noExternal: true` unless they are external.
      external: version.startsWith('6.') ? builtins : undefined,
      ...(split ? { input: { server: 'server.mjs', worker: 'worker.mjs' } } : {}),
      output: {
        format,
        entryFileNames: `[name].${extension}`,
        chunkFileNames: `[name]-[hash].${extension}`,
      },
    },
  },
  ssr: { noExternal },
})
