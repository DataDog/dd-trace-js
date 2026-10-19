'use strict'

const { join } = require('node:path')
const { defineConfig } = require('cypress')

module.exports = defineConfig({
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
