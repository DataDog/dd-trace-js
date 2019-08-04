'use strict'

const path = require('path')
const execSync = require('../../../../../scripts/helpers/exec')

function executeTap (args, options) {
  const tracerSetupPath = path.join(__dirname, '..', 'tracer-setup.js')

  // Inject our tracer before we run the external tests
  try {
    return execSync(`npm run env --silent -- tap --node-arg="--require" --node-arg="${tracerSetupPath}" ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeTap
