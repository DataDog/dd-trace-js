import cypress from 'cypress'

async function runCypress () {
  const results = await cypress.run({
    config: {
      defaultCommandTimeout: 1000,
      e2e: {
        testIsolation: process.env.CYPRESS_TEST_ISOLATION !== 'false',
        setupNodeEvents (on, config) {
          if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
            return import('cypress-fail-fast/plugin').then(module => {
              module.default(on, config)
            })
          }
        },
        specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
      },
      video: false,
      screenshotOnRunFailure: false,
    },
  })

  if (results.totalFailed !== 0) {
    process.exit(1)
  }
}

runCypress()
