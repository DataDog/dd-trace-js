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
      const plugin = require('dd-trace/ci/cypress/plugin')
      await plugin(on, config)
      // Deliberately replace the plugin's after:spec handler to exercise after:run recovery.
      on('after:spec', (spec, results) => {
        const mode = process.env.DD_CYPRESS_AFTER_SPEC_MODE
        if (mode === 'forwarded' || (mode === 'partial' && spec.name === 'first.cy.js')) {
          const afterSpec = require('dd-trace/ci/cypress/after-spec')
          return afterSpec(spec, results)
        }
      })
      return config
    },
  },
})
