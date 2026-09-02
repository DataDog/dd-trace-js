'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    setupNodeEvents (on, config) {
      let afterSpecCount = 0
      on('after:spec', (spec, results) => {
        afterSpecCount++
        // eslint-disable-next-line no-console
        console.log('[custom:after:spec]', spec.relative, results.stats.passes)
        if (process.env.CYPRESS_REJECT_AFTER_SPEC_WITHOUT_REASON) {
          // eslint-disable-next-line prefer-promise-reject-errors
          return Promise.reject()
        }
        if (process.env.CYPRESS_REJECT_AFTER_SPEC &&
          (process.env.CYPRESS_REJECT_AFTER_SPEC === '1' ||
            process.env.CYPRESS_REJECT_AFTER_SPEC === spec.relative)) {
          return Promise.reject(new Error('custom after:spec failed'))
        }
        if (process.env.CYPRESS_REJECT_SECOND_AFTER_SPEC && afterSpecCount === 2) {
          return Promise.reject(new Error('custom after:spec failed'))
        }
        return new Promise((resolve) => {
          setTimeout(() => {
            // eslint-disable-next-line no-console
            console.log('[custom:after:spec:resolved]')
            resolve()
          }, 50)
        })
      })
      on('after:run', (results) => {
        // eslint-disable-next-line no-console
        console.log('[custom:after:run]', results.totalPassed)
        if (process.env.CYPRESS_REJECT_AFTER_RUN) {
          return Promise.reject(new Error('custom after:run failed'))
        }
        if (process.env.CYPRESS_REJECT_AFTER_RUN_WITH_STRING) {
          // eslint-disable-next-line prefer-promise-reject-errors
          return Promise.reject('custom after:run string rejection')
        }
        return new Promise((resolve) => {
          setTimeout(() => {
            // eslint-disable-next-line no-console
            console.log('[custom:after:run:resolved]')
            resolve()
          }, 50)
        })
      })
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: process.env.CYPRESS_ENABLE_FAILURE_VIDEOS === 'true',
  screenshotOnRunFailure: false,
})
