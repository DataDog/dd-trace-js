'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'mongodb-core',
  repo: 'https://github.com/mongodb-js/mongodb-core',
  testType: 'custom',
  testFn: function (tracerSetupPath, options) {
    try {
      execSync(`npm run env -- mongodb-test-runner -t 60000 '${tracerSetupPath}' test/tests`, options)
    } catch (error) {} // eslint-disable-line no-empty
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
