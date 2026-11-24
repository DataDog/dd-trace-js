import { builtinModules } from 'node:module'

import { defineConfig, version } from 'vite'

import { datadogVite } from 'dd-trace/vite.js'

const format = process.env.VITE_OUTPUT_FORMAT
const extension = format === 'es' ? 'mjs' : 'cjs'

export default defineConfig({
  plugins: [datadogVite()],
  logLevel: 'warn',
  build: {
    outDir: `dist-${format}`,
    ssr: 'server.mjs',
    rollupOptions: {
      // Vite 6 cannot bundle built-ins with `ssr.noExternal: true` unless they are external.
      external: version.startsWith('6.') ? builtinModules.flatMap(name => [name, `node:${name}`]) : undefined,
      output: { format, entryFileNames: `[name].${extension}` },
    },
  },
  ssr: { noExternal: true },
})
