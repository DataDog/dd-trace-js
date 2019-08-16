'use strict'

const normalizeTestConfigs = require('../../../scripts/helpers/normalizeTestConfigs')

const defaults = {
  integration: 'restify',
  repo: 'https://github.com/restify/node-restify/'
}

const testConfigs = [
  {
    framework: 'mocha',
    args: '--exit --full-trace test/plugins/*.test.js'
  },
  {
    framework: 'nodeunit',
    args: 'test/*.test.js'
  }
]

module.exports = normalizeTestConfigs(testConfigs, defaults)
