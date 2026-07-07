import fs from 'node:fs'

import { defineConfig } from 'cypress'
import ddTracePlugin from 'dd-trace/ci/cypress/plugin.js'

function renameScreenshot (details) {
  const renamedPath = details.path.replace(/\.png$/, ' datadog-renamed.png')
  try {
    fs.unlinkSync(renamedPath)
  } catch {}
  fs.renameSync(details.path, renamedPath)
  return { path: renamedPath }
}

export default defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    async setupNodeEvents (on, config) {
      if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
        const { default: ddAfterRun } = await import('dd-trace/ci/cypress/after-run.js')
        on('after:run', (...args) => ddAfterRun(...args))
      }
      if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
        const { default: ddAfterSpec } = await import('dd-trace/ci/cypress/after-spec.js')
        on('after:spec', (...args) => ddAfterSpec(...args))
      }
      const resolvedConfig = ddTracePlugin(on, config)
      if (process.env.CYPRESS_ENABLE_AFTER_SCREENSHOT_CUSTOM) {
        on('after:screenshot', renameScreenshot)
      }
      return resolvedConfig
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: process.env.CYPRESS_ENABLE_FAILURE_SCREENSHOTS === 'true',
})
