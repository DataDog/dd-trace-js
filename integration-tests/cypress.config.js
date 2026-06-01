'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    testIsolation: process.env.CYPRESS_TEST_ISOLATION !== 'false',
    setupNodeEvents (on, config) {
      if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
        require('cypress-fail-fast/plugin')(on, config)
      }
      if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
        const ddAfterRun = require('dd-trace/ci/cypress/after-run')
        on('after:run', (...args) => {
          return ddAfterRun(...args)
        })
      }
      if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
        const ddAfterSpec = require('dd-trace/ci/cypress/after-spec')
        on('after:spec', (...args) => {
          return ddAfterSpec(...args)
        })
      }
      if (process.env.CYPRESS_ENABLE_MANUAL_PLUGIN) {
        return require('dd-trace/ci/cypress/plugin')(on, config)
      }
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
