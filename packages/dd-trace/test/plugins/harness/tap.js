'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeTap (tracerSetupPath, args, options) {
  const npmRunEnv = 'npm run env --silent --'

  // Inject our tracer before we run the external tests
  try {
    return execSync(`${npmRunEnv} tap --node-arg="--require" --node-arg="${tracerSetupPath}" ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeTap
