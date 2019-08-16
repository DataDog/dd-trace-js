'use strict'

const execSync = require('child_process').execSync

const testConfigs = [
  {
    integration: 'mongodb-core',
    repo: 'https://github.com/mongodb-js/mongodb-core',
    framework: 'custom',
    execTests: function (tracerSetupPath, options) {
      try {
        execSync(`npm run env -- mongodb-test-runner -t 60000 '${tracerSetupPath}' test/tests`, options)
      } catch (err) {} // eslint-disable-line no-empty
    }
  }
]

module.exports = testConfigs
