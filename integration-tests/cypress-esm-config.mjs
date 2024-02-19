// eslint-disable-next-line import/no-extraneous-dependencies
import cypress from 'cypress'

async function runCypress () {
  await cypress.run({
    config: {
      defaultCommandTimeout: 100,
      e2e: {
        setupNodeEvents (on, config) {
          if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
            import('cypress-fail-fast/plugin').then(module => {
              module.default(on, config)
            })
          }
          import('dd-trace/ci/cypress/plugin').then(module => {
            module.default(on, config)
          })
        }
      },
      video: false,
      screenshotOnRunFailure: false
    }
  })
}

runCypress()
