module.exports = (on, config) => {
  require('dd-trace/ci/cypress/plugin')(on, config)
}
