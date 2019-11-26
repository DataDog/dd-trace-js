'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeNode (tracerSetupPath, args, options) {
  const npmRunEnv = 'npm run env --silent --'

  // Inject our tracer before we run the external tests
  return execSync(`${npmRunEnv} node -r '${tracerSetupPath}' ${args}`, options)
}

module.exports = executeNode
