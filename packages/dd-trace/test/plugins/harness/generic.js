'use strict'

const path = require('path')
const execSync = require('../../../../../scripts/helpers/exec')

function executeGeneric (framework, args, options) {
  const tracerSetupPath = path.join(__dirname, '..', 'tracer-setup.js')

  // Inject our tracer before we run the external tests
  try {
    return execSync(`npm run env --silent -- ${framework} '${tracerSetupPath}' ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeGeneric
