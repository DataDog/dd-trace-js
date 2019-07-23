'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeMocha (args, options) {
  // Inject our tracer before we run the external tests
  return execSync(`npm run env -- mocha '../../../packages/dd-trace/test/plugins/tracer-setup.js' ${args}`, options)
}

module.exports = executeMocha
