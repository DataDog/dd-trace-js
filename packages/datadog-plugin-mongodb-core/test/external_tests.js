'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'mongodb-core',
  repo: 'https://github.com/mongodb-js/mongodb-core',
  testType: 'custom',
  testFn: function (tracerSetupPath, options) {
    options.stdio = [0, 1, 2]
    try {
      execSync(`npm run env -- mongodb-test-runner -t 60000 '${tracerSetupPath}' test/tests`, options)
    } catch (error) {} // eslint-disable-line no-empty
  },
  setup: function (cwd) {
    return execSync('npm install', { cwd })
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
