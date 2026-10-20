'use strict'

const { join } = require('node:path')
const { defineConfig } = require('cypress')
const getCypressTestEnvironment = require('../../cypress-test-environment')

module.exports = defineConfig({
  ...getCypressTestEnvironment(),
  retries: 0,
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    specPattern: join(__dirname, 'retries.cy.js'),
    supportFile: join(__dirname, 'support.js'),
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      const result = await plugin(on, config)
      result.retries = 2
      return result
    },
  },
})
