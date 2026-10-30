'use strict'

const { defineConfig } = require('cypress')

const getCypressTestEnvironment = require('./cypress-test-environment')

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    async setupNodeEvents () {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return {
        ...getCypressTestEnvironment({
          RETURNED_CONFIG_FLAG: 'true',
        }),
        specPattern: 'cypress/e2e/returned-config.cy.js',
      }
    },
    specPattern: 'cypress/e2e/basic-fail.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
