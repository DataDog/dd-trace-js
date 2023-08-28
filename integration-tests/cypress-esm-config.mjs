// eslint-disable-next-line import/no-extraneous-dependencies
import cypress from 'cypress'

async function runCypress () {
  await cypress.run({
    config: {
      defaultCommandTimeout: 100,
      e2e: {
        setupNodeEvents (on, config) {
          import('../ci/cypress/plugin.js').then(module => {
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
