'use strict'

const ddTracePlugin = require('dd-trace/ci/cypress/plugin')

module.exports = {
  defaultCommandTimeout: 1000,
  e2e: {
    setupNodeEvents (on, config) {
      return ddTracePlugin(on, config)
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
  },
  video: false,
  screenshotOnRunFailure: false,
}
