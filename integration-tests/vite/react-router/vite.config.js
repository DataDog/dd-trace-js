import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'

import { datadogVite } from 'dd-trace/vite.js'

export default defineConfig({
  plugins: [reactRouter(), datadogVite()],
  logLevel: 'warn',
  // Bundles the Orchestrion target into the server build, so only the plugin can instrument it.
  ssr: { noExternal: ['ai'] },
})
