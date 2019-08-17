'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeBinary (tracerSetupPath, binary, args, options) {
  const npmRunEnv = 'npm run env --silent --'

  // Inject our tracer before we run the external tests
  return execSync(`${npmRunEnv} node -r '${tracerSetupPath}' ./node_modules/.bin/${binary} ${args}`, options)
}

module.exports = executeBinary
