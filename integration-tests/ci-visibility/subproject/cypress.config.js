module.exports = {
  defaultCommandTimeout: 100,
  e2e: {
    setupNodeEvents (on, config) {
      return require('dd-trace/ci/cypress/plugin')(on, config) // eslint-disable-line n/no-extraneous-require
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js'
  },
  video: false,
  screenshotOnRunFailure: false
}
