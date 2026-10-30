import { defineConfig } from 'electron-vite'

import { datadogVite } from 'dd-trace/vite.js'

export default defineConfig({
  main: {
    // The preload script is also a server build, so the plugin is only added to the main process configuration.
    plugins: [datadogVite()],
    build: {
      // Dependencies listed in package.json `dependencies` are external, devDependencies are bundled.
      externalizeDeps: true,
      rollupOptions: { input: { index: 'src/main.mjs' } },
    },
  },
})
