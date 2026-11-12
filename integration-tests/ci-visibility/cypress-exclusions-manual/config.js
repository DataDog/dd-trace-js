'use strict'

const { join } = require('node:path')
const { defineConfig } = require('cypress')
const getCypressTestEnvironment = require('../../cypress-test-environment')

module.exports = defineConfig({
  ...getCypressTestEnvironment(),
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    specPattern: join(__dirname, 'exclusions.cy.js'),
    supportFile: join(__dirname, 'support.js'),
    setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      return plugin(on, config)
    },
  },
})
