'use strict'

const execSync = require('../../../../../scripts/helpers/exec')

function executeLab (args, options) {
  // Inject our tracer before we run the external tests
  try {
    return execSync(`npm run env -- lab '../../../packages/dd-trace/test/plugins/tracer-setup.js' ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeLab
