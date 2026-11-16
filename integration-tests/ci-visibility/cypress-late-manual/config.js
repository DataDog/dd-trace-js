'use strict'

const { join } = require('node:path')

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  video: process.env.DD_TEST_FAILURE_VIDEOS_ENABLED === 'true',
  screenshotOnRunFailure: process.env.DD_TEST_FAILURE_SCREENSHOTS_ENABLED === 'true',
  e2e: {
    specPattern: join(__dirname, '*.cy.js'),
    supportFile: join(__dirname, 'support.js'),
    async setupNodeEvents (on, config) {
      const mode = process.env.DD_CYPRESS_AFTER_SPEC_MODE
      const plugin = require('dd-trace/ci/cypress/plugin')
      // Cypress 16.3.0+ runs every after:spec handler instead of only the last one. Drop the plugin's
      // handler so recovery modes exercise after:run on every version, while forwarded mode keeps both
      // to cover the plugin receiving the same spec twice.
      const registerPluginEvent = mode === 'forwarded'
        ? on
        : (event, handler) => {
            if (event !== 'after:spec') on(event, handler)
          }
      await plugin(registerPluginEvent, config)
      on('after:spec', (spec, results) => {
        if (mode === 'forwarded' || (mode === 'partial' && spec.name === 'first.cy.js')) {
          const afterSpec = require('dd-trace/ci/cypress/after-spec')
          return afterSpec(spec, results)
        }
      })
      return config
    },
  },
})
