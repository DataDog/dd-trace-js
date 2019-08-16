'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalizeTestConfigs')

const defaults = {
  integration: 'q',
  repo: 'https://github.com/kriskowal/q'
}

const testConfigs = [
  {
    framework: 'promises-aplus-tests',
    args: 'spec/aplus-adapter'
  },
  {
    framework: 'jasmine-node',
    args: 'spec'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
