'use strict'

const { join } = require('node:path')
const { defineConfig } = require('cypress')
const getCypressTestEnvironment = require('../../cypress-test-environment')

module.exports = defineConfig({
  ...getCypressTestEnvironment(),
  retries: { runMode: 0, openMode: 0 },
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    specPattern: join(__dirname, 'retries.cy.js'),
    supportFile: join(__dirname, 'support.js'),
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      const result = await plugin(on, config)
      const mode = process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE
      if (mode === 'equal-object') result.retries = { runMode: 2, openMode: 0 }
      else if (mode === 'equal-nested') result.retries.runMode = 2
      else if (mode === 'returned-object') return { retries: { runMode: 2, openMode: 0 } }
      else if (mode !== 'unchanged') result.retries = 2
      return result
    },
  },
})
