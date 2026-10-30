import { defineConfig } from 'vite'

const format = process.env.VITE_OUTPUT_FORMAT === 'cjs' ? 'cjs' : 'es'

export default defineConfig({
  build: {
    ssr: 'server.mjs',
    outDir: `dist-${format}`,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format,
        entryFileNames: format === 'es' ? 'server.mjs' : 'server.cjs',
      },
    },
  },
  // Bundle dd-trace into the application, without a dd-trace plugin, instead of loading it from node_modules.
  ssr: {
    noExternal: true,
  },
})
