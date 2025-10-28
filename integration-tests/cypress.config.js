'use strict'

const ddAfterRun = require('dd-trace/ci/cypress/after-run')
const ddAfterSpec = require('dd-trace/ci/cypress/after-spec')
const cypressFailFast = require('cypress-fail-fast/plugin')
const ddTracePlugin = require('dd-trace/ci/cypress/plugin')

module.exports = {
  defaultCommandTimeout: 5000,
  e2e: {
    setupNodeEvents (on, config) {
      if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
        cypressFailFast(on, config)
      }
      if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
        on('after:run', (...args) => {
          // do custom stuff
          // and call after-run at the end
          return ddAfterRun(...args)
        })
      }
      if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
        on('after:spec', (...args) => {
          // do custom stuff
          // and call after-spec at the end
          return ddAfterSpec(...args)
        })
      }
      return ddTracePlugin(on, config)
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js'
  },
  video: false,
  screenshotOnRunFailure: false
}
