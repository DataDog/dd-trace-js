'use strict'

const path = require('path')
const execSync = require('child_process').execSync

function executeJest (args, options) {
  const tracerSetupPath = path.join(__dirname, '..', 'tracer-setup.js')

  // Inject our tracer before we run the external tests
  try {
    return execSync(`node --inspect-brk ./node_modules/.bin/jest --runInBand ${args}`, options)
    // return execSync(`npm run env -- jest --runInBand --setupTestFrameworkScriptFile='${tracerSetupPath}' ${args}`, options)
  } catch (err) {} // eslint-disable-line no-empty
}

module.exports = executeJest
