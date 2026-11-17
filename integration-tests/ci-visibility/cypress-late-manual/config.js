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
      // Two after:spec handlers are registered directly with Cypress, because dd-trace loads too late
      // here to wrap `on`: the dd-trace plugin's own handler, and the custom handler below, which stands
      // in for a customer's after:spec. The custom handler calls dd-trace's `after-spec` helper for every
      // spec (forwarded), only for first.cy.js (partial) or for no spec (missing).
      // - Before Cypress 16.3.0, Cypress keeps only the last after:spec handler, so the custom handler
      //   replaces the plugin's. dd-trace only receives the specs the custom handler passes to `after-spec`.
      // - From Cypress 16.3.0, Cypress runs every after:spec handler in registration order: first the
      //   plugin's, then the custom one.
      // In missing and partial modes, the specs not passed to `after-spec` must be recovered at after:run.
      // The plugin's after:spec handler is hidden from Cypress so the custom handler still effectively
      // replaces it on every version. In forwarded mode both are registered: before 16.3.0 dd-trace
      // receives each spec once, and from 16.3.0 twice, and it must finalize each spec only once.
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
