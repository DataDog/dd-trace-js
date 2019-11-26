'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalize_test_configs')

const defaults = {
  integration: 'when',
  repo: 'https://github.com/cujojs/when'
}

const testConfigs = [
  {
    framework: 'buster-test',
    args: '-e node'
  },
  {
    framework: 'promises-aplus-tests',
    args: 'test/promises-aplus-adapter.js'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
