// Programmatic ESM entry point for the 'esm' module type tests.
// Instrumentation works via the default cypress.config.js in the project
// (which uses defineConfig), NOT via the inline setupNodeEvents below —
// Cypress does not call setupNodeEvents from inline config objects.
import cypress from 'cypress'

async function runCypress () {
  const results = await cypress.run({
    config: {
      defaultCommandTimeout: 1000,
      retries: {
        runMode: Number(process.env.CYPRESS_RETRIES || 0),
        openMode: 0,
      },
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
      // Mirror the env-driven gating in cypress.config.js: off by default so most
      // specs do not capture screenshots; the failure-screenshot upload tests set
      // CYPRESS_ENABLE_FAILURE_SCREENSHOTS=true for their runs.
      // The 'esm' module type runs Cypress through this programmatic config rather
      // than cypress.config.js, so the same gating has to live here too.
      video: false,
      screenshotOnRunFailure: process.env.CYPRESS_ENABLE_FAILURE_SCREENSHOTS === 'true',
    },
  })

  const failures = results.totalFailed ?? results.failures ?? 0
  if (failures !== 0) {
    process.exit(failures)
  }
}

runCypress()
