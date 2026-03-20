'use strict'

// Backwards compatibility config: uses defineConfig AND the old manual plugin.
// When NODE_OPTIONS is set, the instrumentation wraps defineConfig and injects
// setupNodeEvents. The manual plugin call inside the user's setupNodeEvents sets
// cypressPlugin._isInit = true, so the instrumentation skips its own registration.
const { defineConfig } = require('cypress')
const ddTracePlugin = require('dd-trace/ci/cypress/plugin')

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    setupNodeEvents (on, config) {
      return ddTracePlugin(on, config)
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
