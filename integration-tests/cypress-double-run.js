'use strict'

// Tests that cypress.run() works twice in the same process (resetRunState).
// Instrumentation works via the default cypress.config.js in the project
// (which uses defineConfig), NOT via the inline config below — Cypress
// does not call setupNodeEvents from inline config objects.
const cypress = require('cypress')

const runOptions = {
  config: {
    defaultCommandTimeout: 1000,
    e2e: {
      supportFile: 'cypress/support/e2e.js',
      testIsolation: process.env.CYPRESS_TEST_ISOLATION !== 'false',
      specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
    },
    video: false,
    screenshotOnRunFailure: false,
  },
}

async function runCypressTwice () {
  for (let runNumber = 0; runNumber < 2; runNumber++) {
    const results = await cypress.run(runOptions)
    if (results.totalFailed !== 0) {
      process.exit(1)
    }
  }
}

runCypressTwice().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exit(1)
})
