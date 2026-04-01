import cypress from 'cypress'

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

for (let runNumber = 0; runNumber < 2; runNumber++) {
  const results = await cypress.run(runOptions)
  if (results.totalFailed !== 0) {
    process.exit(1)
  }
}
