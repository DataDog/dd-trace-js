'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeGeneric (tracerSetupPath, framework, args, options) {
  // Inject our tracer before we run the external tests
  return execSync(`npm run env --silent -- ${framework} '${tracerSetupPath}' ${args}`, options)
}

module.exports = executeGeneric
