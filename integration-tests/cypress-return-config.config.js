'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    setupNodeEvents () {
      return {
        env: {
          RETURNED_CONFIG_FLAG: 'true',
        },
        specPattern: 'cypress/e2e/returned-config.cy.js',
      }
    },
    specPattern: 'cypress/e2e/basic-fail.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
