'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalizeTestConfigs')

const defaults = {
  integration: 'express',
  repo: 'https://github.com/expressjs/express',
  framework: 'mocha',
  args: '--require test/support/env --reporter spec --check-leaks test/ test/acceptance/'
}

const testConfigs = [
  {
    branch: '4.x'
  },
  {
    branch: '5.x'
  },
  {
    branch: 'master'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
