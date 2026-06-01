import { defineConfig } from 'cypress'
import ddTracePlugin from 'dd-trace/ci/cypress/plugin.js'

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
      return ddTracePlugin(on, config)
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
