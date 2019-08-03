'use strict'

const path = require('path')
const execSync = require('../../../../../scripts/helpers/exec')

function executeNodeunit (args, options) {
  const tracerSetupPath = path.join(__dirname, '..', 'tracer-setup.js')

  // Inject our tracer before we run the external tests
  try {
    return execSync(`node --inspect-brk -r "${tracerSetupPath}" ./node_modules/.bin/nodeunit ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeNodeunit
