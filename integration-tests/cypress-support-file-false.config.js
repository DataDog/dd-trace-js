'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  e2e: {
    specPattern: 'cypress/e2e/support-file-false.cy.js',
    supportFile: false,
  },
  video: false,
  screenshotOnRunFailure: false,
})
