module.exports = {
  defaultCommandTimeout: 100,
  e2e: {
    setupNodeEvents (on, config) {
      require('dd-trace/ci/cypress/plugin')(on, config)
    }
  },
  video: false,
  quiet: true
}
