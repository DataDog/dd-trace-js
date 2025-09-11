'use strict'

const ddAfterRun = require('dd-trace/ci/cypress/after-run')
const ddAfterSpec = require('dd-trace/ci/cypress/after-spec')

module.exports = (on, config) => {
  if (process.env.CYPRESS_ENABLE_INCOMPATIBLE_PLUGIN) {
    require('cypress-fail-fast/plugin')(on, config)
  }
  if (process.env.SPEC_PATTERN) {
    config.testFiles = process.env.SPEC_PATTERN.replace('cypress/e2e/', '')
  }
  if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
    on('after:run', (...args) => {
      // do custom stuff
      // and call after-run at the end
      return ddAfterRun(...args)
    })
  }
  if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
    on('after:spec', (...args) => {
      // do custom stuff
      // and call after-spec at the end
      return ddAfterSpec(...args)
    })
  }
  return require('dd-trace/ci/cypress/plugin')(on, config)
}
