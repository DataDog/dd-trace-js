'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalize_test_configs')

const defaults = {
  integration: 'connect',
  repo: 'https://github.com/senchalabs/connect',
  framework: 'mocha',
  args: '--require test/support/env --reporter spec --check-leaks test/'
}

const testConfigs = [
  {
    branch: '2.30.2'
  },
  {
    branch: 'master'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
