'use strict'

const execSync = require('child_process').execSync
const normalizeTestConfigs = require('../../../scripts/helpers/normalize_test_configs')

const defaults = {
  integration: 'promise',
  repo: 'https://github.com/then/promise',
  setup: function (tracerSetupPath, options) {
    execSync('npm install && npm build', options)
  }
}

const testConfigs = [
  {
    framework: 'mocha',
    args: '--timeout 200 --slow 99999 "test/**/*"'
  },
  {
    name: 'promise (master) - memory leak test',
    framework: 'node',
    args: '--expose-gc test/memory-leak.js'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
