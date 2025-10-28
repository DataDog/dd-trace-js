import cypress from 'cypress'

async function runCypress () {
  const results = await cypress.run({
    config: {
      defaultCommandTimeout: 5000,
      e2e: {
        setupNodeEvents (on, config) {
          if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
            import('cypress-fail-fast/plugin').then(module => {
              module.default(on, config)
            })
          }
          if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
            on('after:run', (...args) => {
              // do custom stuff
              // and call after-run at the end
              return import('dd-trace/ci/cypress/after-run').then(module => {
                module.default(...args)
              })
            })
          }
          if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
            on('after:spec', (...args) => {
              // do custom stuff
              // and call after-spec at the end
              return import('dd-trace/ci/cypress/after-spec').then(module => {
                module.default(...args)
              })
            })
          }
          return import('dd-trace/ci/cypress/plugin').then(module => {
            return module.default(on, config)
          })
        },
        specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js'
      },
      video: false,
      screenshotOnRunFailure: false
    }
  })
  if (results.totalFailed !== 0) {
    process.exit(1)
  }
}

runCypress()
