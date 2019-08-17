'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeTape (tracerSetupPath, args, options) {
  // Inject our tracer before we run the external tests
  return execSync(`npm run env --silent -- tape -r '${tracerSetupPath}' ${args}`, options)
}

module.exports = executeTape
