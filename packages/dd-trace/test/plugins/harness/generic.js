'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeGeneric (framework, tracerSetupPath, args, options) {
  // Inject our tracer before we run the external tests
  try {
    return execSync(`npm run env --silent -- ${framework} '${tracerSetupPath}' ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeGeneric
