const setupNodeEvents = require('./cypress/plugins/index.js')

module.exports = {
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    setupNodeEvents,
    supportFile: 'cypress/support/index.js',
    specPattern: 'cypress/integration/**.js'
  }
}
