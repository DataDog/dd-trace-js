module.exports = (on, config) => {
  if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
    require('cypress-fail-fast/plugin')(on, config)
  }
  require('dd-trace/ci/cypress/plugin')(on, config)
}
