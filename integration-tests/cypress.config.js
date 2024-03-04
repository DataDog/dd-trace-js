module.exports = {
  defaultCommandTimeout: 100,
  e2e: {
    setupNodeEvents (on, config) {
      if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
        require('cypress-fail-fast/plugin')(on, config)
      }
      require('dd-trace/ci/cypress/plugin')(on, config)
      if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
        on('after:run', (...args) => {
          // do custom stuff
          // and call after-run at the end
          require('dd-trace/ci/cypress/after-run')(...args)
        })
      }
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js'
  },
  video: false,
  screenshotOnRunFailure: false
}
