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
      // dd-trace loads too late here to wrap `on`, so the plugin's after:spec handler and the user's
      // handler below are both registered directly with Cypress:
      // - Before Cypress 16.3.0, Cypress keeps only the last after:spec handler, so the user's handler
      //   replaces the plugin's. dd-trace only sees the specs the user forwards to `after-spec`.
      // - From Cypress 16.3.0, Cypress runs every after:spec handler in registration order, so the
      //   plugin's handler runs and then the user's handler runs.
      // Per mode:
      // - missing / partial: the user forwards no specs / only first.cy.js, and the rest must be recovered
      //   at after:run. Hide the plugin's after:spec handler so it is never registered, keeping the
      //   pre-16.3.0 "replaced" behavior on every version.
      // - forwarded: the user forwards every spec. Register both handlers: before 16.3.0 dd-trace sees each
      //   spec once, and from 16.3.0 it sees each spec twice and must finalize it only once.
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
