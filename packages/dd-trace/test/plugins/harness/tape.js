'use strict'

const path = require('path')
const execSync = require('../../../../../scripts/helpers/exec')

function executeTape (args, options) {
  const tracerSetupPath = path.join(__dirname, '..', 'tracer-setup.js')

  // Inject our tracer before we run the external tests
  try {
    return execSync(`npm run env -- tape -r '${tracerSetupPath}' ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeTape
