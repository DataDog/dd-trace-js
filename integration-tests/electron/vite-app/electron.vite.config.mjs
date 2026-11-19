import { defineConfig } from 'electron-vite'

import { datadogVite } from 'dd-trace/vite.js'

const format = process.env.VITE_OUTPUT_FORMAT
const bundled = process.env.VITE_TRACER === 'bundled'

export default defineConfig({
  main: {
    plugins: [datadogVite()],
    logLevel: 'warn',
    build: {
      // The Electron SDK currently externalizes the tracer. Also exercise bundling it for future SDK builds.
      externalizeDeps: bundled ? false : { include: ['dd-trace'] },
      rollupOptions: {
        // The generated ESM wrappers must use the same instance as the external tracer.
        external: bundled ? undefined : [/[/\\]import-in-the-middle[/\\]/],
        input: { index: 'src/main.mjs' },
        output: { format, entryFileNames: format === 'es' ? '[name].mjs' : '[name].cjs' },
      },
    },
  },
})
