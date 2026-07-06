'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  retries: {
    runMode: Number(process.env.CYPRESS_RETRIES || 0),
    openMode: 0,
  },
  e2e: {
    testIsolation: process.env.CYPRESS_TEST_ISOLATION !== 'false',
    setupNodeEvents (on, config) {
      if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
        require('cypress-fail-fast/plugin')(on, config)
      }
      if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
        const ddAfterRun = require('dd-trace/ci/cypress/after-run')
        on('after:run', (...args) => {
          return ddAfterRun(...args)
        })
      }
      if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
        const ddAfterSpec = require('dd-trace/ci/cypress/after-spec')
        on('after:spec', (...args) => {
          return ddAfterSpec(...args)
        })
      }
      if (process.env.CYPRESS_DD_BEFORE_EACH_NO_RESULT_ONCE) {
        const ddTracePlugin = require('dd-trace/ci/cypress/plugin')
        let ddBeforeEachCalls = 0

        const wrappedOn = (event, handler) => {
          if (event !== 'task' || !handler['dd:beforeEach']) {
            on(event, handler)
            return
          }

          const ddBeforeEach = handler['dd:beforeEach']
          on('task', {
            ...handler,
            'dd:beforeEach': (test) => {
              ddBeforeEachCalls++
              // eslint-disable-next-line no-console
              console.log(`[datadog:test] dd:beforeEach call ${ddBeforeEachCalls}`)
              const result = ddBeforeEach(test)
              if (ddBeforeEachCalls === 1) {
                return null
              }
              return result
            },
          })
        }

        return ddTracePlugin(wrappedOn, config)
      }
      if (process.env.CYPRESS_ENABLE_MANUAL_PLUGIN) {
        return require('dd-trace/ci/cypress/plugin')(on, config)
      }
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  // Off by default so most specs do not capture screenshots; the failure-screenshot
  // upload tests set CYPRESS_ENABLE_FAILURE_SCREENSHOTS=true for their runs.
  video: false,
  screenshotOnRunFailure: process.env.CYPRESS_ENABLE_FAILURE_SCREENSHOTS === 'true',
})
