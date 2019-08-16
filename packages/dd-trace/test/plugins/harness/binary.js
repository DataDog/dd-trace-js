'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeBinary (binary, tracerSetupPath, args, options) {
  const npmRunEnv = 'npm run env --silent --'

  // Inject our tracer before we run the external tests
  try {
    return execSync(`${npmRunEnv} node -r '${tracerSetupPath}' ./node_modules/.bin/${binary} ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeBinary
