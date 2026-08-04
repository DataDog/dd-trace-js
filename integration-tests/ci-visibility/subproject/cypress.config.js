'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
