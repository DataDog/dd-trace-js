'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'promise',
  repo: 'https://github.com/then/promise',
  testType: 'mocha',
  testArgs: 'test/resolver-tests.js test/extensions-tests.js',
  setup: function (cwd) {
    execSync('npm install && npm build', { cwd })
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
