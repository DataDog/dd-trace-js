import { defineConfig } from 'cypress'

export default defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    setupNodeEvents (on, config) {
      on('after:spec', (spec, results) => {
        // eslint-disable-next-line no-console
        console.log('[custom:after:spec]', spec.relative, results.stats.passes)
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
  video: false,
  screenshotOnRunFailure: false,
})
