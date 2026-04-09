// Programmatic ESM entry point for the 'esm' module type tests.
// Instrumentation works via the default cypress.config.js in the project
// (which uses defineConfig), NOT via the inline setupNodeEvents below —
// Cypress does not call setupNodeEvents from inline config objects.
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
